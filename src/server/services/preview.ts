import { spawn, execFile, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { promisify } from 'util';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import {
  DEFAULT_PREVIEW_COMMAND,
  DEFAULT_PREVIEW_INSTALL_COMMAND,
  PORT as PM_AI_PORT,
  PREVIEW_BASE_PORT,
  PreviewStatus,
  ProjectConfig,
} from '../../shared/schemas.js';
import { readProjectConfig } from './files.js';
import { getExecutionPath } from './git.js';

const execFileAsync = promisify(execFile);

const MAX_LOG_LINES = 80;
const runningChildren = new Map<string, ChildProcess>();

export interface PreviewInfo {
  status: PreviewStatus;
  port: number | null;
  url: string | null;
  pid: number | null;
  cwd: string | null;
  command: string | null;
  log_tail: string[];
  error: string | null;
  started_at: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function previewUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function parseTaskSeq(taskId: string): number {
  const match = taskId.match(/-(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

function parseLogTail(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function appendLog(lines: string[], chunk: string): string[] {
  const next = [...lines];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue;
    next.push(line);
  }
  return next.slice(-MAX_LOG_LINES);
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function allocatePort(taskId: string, excludePorts: Set<number>): Promise<number> {
  let port = PREVIEW_BASE_PORT + parseTaskSeq(taskId);
  for (let i = 0; i < 200; i++) {
    if (port !== PM_AI_PORT && !excludePorts.has(port) && (await isPortFree(port))) {
      return port;
    }
    port++;
  }
  throw new Error('找不到可用端口');
}

function substituteCommand(command: string, port: number): string {
  return command.replace(/\{port\}/g, String(port));
}

function buildEnv(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: String(port),
    PM_AI_PORT: String(port),
    HOST: '127.0.0.1',
    PM_AI_HOST: '127.0.0.1',
  };
}

function formatExitError(code: number | null, stderr: string, cwd: string): string {
  const signed = code !== null && code > 0x7fffffff ? code - 0x100000000 : code;
  if (signed === -4058 || code === 4294963238) {
    const hint = suggestPackageJsonDirs(cwd);
    return `找不到 package.json（工作目錄：${cwd}）${hint}`;
  }
  const tail = stderr.trim().split(/\r?\n/).slice(-3).join('\n');
  if (tail) return `進程退出 code=${signed ?? 'null'}\n${tail}`;
  return `進程退出 code=${signed ?? 'null'}`;
}

const COMMON_PREVIEW_SUBDIRS = ['frontend', 'web', 'client', 'app', 'packages/web'];

function suggestPackageJsonDirs(baseCwd: string): string {
  try {
    const found: string[] = [];
    for (const name of COMMON_PREVIEW_SUBDIRS) {
      if (fs.existsSync(path.join(baseCwd, name, 'package.json'))) found.push(name);
    }
    const entries = fs.readdirSync(baseCwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (COMMON_PREVIEW_SUBDIRS.includes(entry.name)) continue;
      if (fs.existsSync(path.join(baseCwd, entry.name, 'package.json'))) found.push(entry.name);
    }
    const unique = [...new Set(found)];
    if (unique.length === 1) {
      return `。偵測到子目錄「${unique[0]}/」含 package.json，請在專案設定將「工作子目錄」設為 ${unique[0]}`;
    }
    if (unique.length > 1) {
      return `。偵測到多個含 package.json 的子目錄：${unique.join('、')}，請在專案設定指定「工作子目錄」`;
    }
  } catch {
    // ignore
  }
  return '。請確認專案設定中的工作子目錄或啟動命令';
}

function resolveWorkdir(baseCwd: string, previewWorkdir: string | undefined): string {
  const trimmed = previewWorkdir?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!trimmed) return baseCwd;
  const resolved = path.resolve(baseCwd, trimmed);
  const base = path.resolve(baseCwd);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('工作子目錄超出允許範圍');
  }
  return resolved;
}

function detectPreviewCwd(baseCwd: string, previewWorkdir: string | undefined): { cwd: string; autoDetected?: string } {
  const explicit = previewWorkdir?.trim();
  if (explicit) {
    return { cwd: resolveWorkdir(baseCwd, explicit) };
  }
  if (fs.existsSync(path.join(baseCwd, 'package.json'))) {
    return { cwd: baseCwd };
  }
  for (const name of COMMON_PREVIEW_SUBDIRS) {
    const sub = path.join(baseCwd, name);
    if (fs.existsSync(path.join(sub, 'package.json'))) {
      return { cwd: sub, autoDetected: name };
    }
  }
  try {
    const entries = fs.readdirSync(baseCwd, { withFileTypes: true });
    const matches = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .filter((name) => fs.existsSync(path.join(baseCwd, name, 'package.json')));
    if (matches.length === 1) {
      return { cwd: path.join(baseCwd, matches[0]), autoDetected: matches[0] };
    }
  } catch {
    // ignore
  }
  return { cwd: baseCwd };
}

function spawnPreviewProcess(command: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  return spawn(command, [], {
    cwd,
    env,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function needsInstall(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, 'package.json')) && !fs.existsSync(path.join(cwd, 'node_modules'));
}

async function runShellCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync(command, {
    cwd,
    env,
    shell: true,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  } as Parameters<typeof execFileAsync>[2]);
}

function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    resolve();
  });
}

function getPreviewRow(taskUid: string) {
  const db = getDb();
  return db.select().from(schema.previewServers).where(eq(schema.previewServers.taskUid, taskUid)).get();
}

function savePreviewRow(row: {
  taskUid: string;
  projectId: string;
  taskId: string;
  status: PreviewStatus;
  port?: number | null;
  pid?: number | null;
  cwd?: string | null;
  command?: string | null;
  logTail?: string[];
  error?: string | null;
  startedAt?: string | null;
}) {
  const db = getDb();
  const ts = now();
  db.insert(schema.previewServers)
    .values({
      taskUid: row.taskUid,
      projectId: row.projectId,
      taskId: row.taskId,
      status: row.status,
      port: row.port ?? null,
      pid: row.pid ?? null,
      cwd: row.cwd ?? null,
      command: row.command ?? null,
      logTail: JSON.stringify(row.logTail ?? []),
      error: row.error ?? null,
      startedAt: row.startedAt ?? null,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: schema.previewServers.taskUid,
      set: {
        status: row.status,
        port: row.port ?? null,
        pid: row.pid ?? null,
        cwd: row.cwd ?? null,
        command: row.command ?? null,
        logTail: JSON.stringify(row.logTail ?? []),
        error: row.error ?? null,
        startedAt: row.startedAt ?? null,
        updatedAt: ts,
      },
    })
    .run();
}

function rowToPreview(row: typeof schema.previewServers.$inferSelect | undefined): PreviewInfo {
  if (!row) {
    return {
      status: 'stopped',
      port: null,
      url: null,
      pid: null,
      cwd: null,
      command: null,
      log_tail: [],
      error: null,
      started_at: null,
    };
  }

  let status = row.status as PreviewStatus;
  const pid = row.pid ?? null;
  if ((status === 'running' || status === 'starting') && pid && !isProcessAlive(pid)) {
    status = 'stopped';
  }

  return {
    status,
    port: row.port ?? null,
    url: row.port ? previewUrl(row.port) : null,
    pid,
    cwd: row.cwd ?? null,
    command: row.command ?? null,
    log_tail: parseLogTail(row.logTail),
    error: row.error ?? null,
    started_at: row.startedAt ?? null,
  };
}

export function resolvePreviewCwd(
  workspacePath: string,
  task: {
    worktree_path?: string | null;
    isolation_status?: string | null;
    use_isolation?: boolean | null;
  },
): string {
  return getExecutionPath(workspacePath, {
    worktree_path: task.worktree_path,
    isolation_status: task.isolation_status,
    use_isolation: task.use_isolation,
  });
}

export function validatePreviewCwd(
  workspacePath: string,
  cwd: string,
  worktreePath?: string | null,
): void {
  const ws = path.resolve(workspacePath);
  const target = path.resolve(cwd);
  if (target.startsWith(ws + path.sep) || target === ws) return;
  if (worktreePath) {
    const wt = path.resolve(worktreePath);
    if (target.startsWith(wt + path.sep) || target === wt) return;
  }
  throw new Error('預覽工作目錄超出 workspace 範圍');
}

function getProjectPreviewConfig(workspacePath: string): Pick<
  ProjectConfig,
  'preview_command' | 'preview_install_command' | 'preview_install_if_needed' | 'preview_workdir'
> {
  const config = readProjectConfig(workspacePath);
  return {
    preview_command: config?.preview_command ?? DEFAULT_PREVIEW_COMMAND,
    preview_install_command: config?.preview_install_command ?? DEFAULT_PREVIEW_INSTALL_COMMAND,
    preview_install_if_needed: config?.preview_install_if_needed ?? true,
    preview_workdir: config?.preview_workdir ?? '',
  };
}

export function getPreviewStatus(taskUid: string): PreviewInfo {
  const row = getPreviewRow(taskUid);
  const info = rowToPreview(row);
  if (row && info.status === 'stopped' && row.status !== 'stopped' && row.status !== 'error') {
    savePreviewRow({
      taskUid: row.taskUid,
      projectId: row.projectId,
      taskId: row.taskId,
      status: 'stopped',
      port: row.port,
      pid: null,
      cwd: row.cwd,
      command: row.command,
      logTail: parseLogTail(row.logTail),
      error: null,
      startedAt: row.startedAt,
    });
  }
  return info;
}

export async function startPreview(
  projectId: string,
  taskUid: string,
  taskId: string,
  workspacePath: string,
  task: {
    worktree_path?: string | null;
    isolation_status?: string | null;
    use_isolation?: boolean | null;
  },
): Promise<PreviewInfo> {
  const existing = getPreviewRow(taskUid);
  if (existing?.pid && isProcessAlive(existing.pid)) {
    return rowToPreview(existing);
  }

  const baseCwd = resolvePreviewCwd(workspacePath, task);
  const previewConfig = getProjectPreviewConfig(workspacePath);
  const { cwd, autoDetected } = detectPreviewCwd(baseCwd, previewConfig.preview_workdir);
  validatePreviewCwd(workspacePath, cwd, task.worktree_path);
  if (!fs.existsSync(cwd)) {
    throw new Error(`工作目錄不存在：${cwd}`);
  }
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(`找不到 package.json${suggestPackageJsonDirs(baseCwd)}`);
  }

  const reserved = new Set<number>();
  const db = getDb();
  for (const row of db.select().from(schema.previewServers).all()) {
    if (row.port) reserved.add(row.port);
  }

  const port = await allocatePort(taskId, reserved);
  const command = substituteCommand(previewConfig.preview_command, port);
  let logTail: string[] = [];
  if (autoDetected) {
    logTail = appendLog(logTail, `[pm-ai] 自動使用子目錄：${autoDetected}/`);
  }
  const startedAt = now();

  savePreviewRow({
    taskUid,
    projectId,
    taskId,
    status: 'starting',
    port,
    pid: null,
    cwd,
    command,
    logTail,
    error: null,
    startedAt,
  });

  try {
    const env = buildEnv(port);

    if (previewConfig.preview_install_if_needed && needsInstall(cwd)) {
      logTail = appendLog(logTail, `[pm-ai] 正在安裝依賴：${previewConfig.preview_install_command}`);
      savePreviewRow({
        taskUid,
        projectId,
        taskId,
        status: 'starting',
        port,
        pid: null,
        cwd,
        command,
        logTail,
        error: null,
        startedAt,
      });
      await runShellCommand(previewConfig.preview_install_command, cwd, env);
      logTail = appendLog(logTail, '[pm-ai] 依賴安裝完成');
    }

    logTail = appendLog(logTail, `[pm-ai] 啟動：${command}（cwd: ${cwd}）`);
    let stderrBuf = '';
    const child = spawnPreviewProcess(command, cwd, env);

    if (!child.pid) {
      throw new Error('無法啟動子進程');
    }

    runningChildren.set(taskUid, child);

    const persistRunning = () => {
      savePreviewRow({
        taskUid,
        projectId,
        taskId,
        status: 'running',
        port,
        pid: child.pid ?? null,
        cwd,
        command,
        logTail,
        error: null,
        startedAt,
      });
    };

    child.stdout?.on('data', (buf: Buffer) => {
      logTail = appendLog(logTail, buf.toString());
      persistRunning();
    });

    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stderrBuf += text;
      logTail = appendLog(logTail, text);
      persistRunning();
    });

    child.on('exit', (code) => {
      runningChildren.delete(taskUid);
      const exitError = code === 0 ? null : formatExitError(code, stderrBuf, cwd);
      logTail = appendLog(logTail, `[pm-ai] 進程已結束 (${exitError ?? '正常停止'})`);
      savePreviewRow({
        taskUid,
        projectId,
        taskId,
        status: code === 0 ? 'stopped' : 'error',
        port,
        pid: null,
        cwd,
        command,
        logTail,
        error: exitError,
        startedAt,
      });
    });

    child.unref();

    savePreviewRow({
      taskUid,
      projectId,
      taskId,
      status: 'running',
      port,
      pid: child.pid,
      cwd,
      command,
      logTail,
      error: null,
      startedAt,
    });

    return getPreviewStatus(taskUid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logTail = appendLog(logTail, `[pm-ai] 錯誤：${message}`);
    savePreviewRow({
      taskUid,
      projectId,
      taskId,
      status: 'error',
      port,
      pid: null,
      cwd,
      command,
      logTail,
      error: message,
      startedAt,
    });
    throw new Error(message);
  }
}

export async function stopPreview(taskUid: string): Promise<PreviewInfo> {
  const row = getPreviewRow(taskUid);
  if (!row) {
    return getPreviewStatus(taskUid);
  }

  const child = runningChildren.get(taskUid);
  const pid = child?.pid ?? row.pid;
  if (pid) {
    await killProcessTree(pid);
  }
  runningChildren.delete(taskUid);

  const logTail = appendLog(parseLogTail(row.logTail), '[pm-ai] 已停止');
  savePreviewRow({
    taskUid: row.taskUid,
    projectId: row.projectId,
    taskId: row.taskId,
    status: 'stopped',
    port: row.port,
    pid: null,
    cwd: row.cwd,
    command: row.command,
    logTail,
    error: null,
    startedAt: row.startedAt,
  });

  return getPreviewStatus(taskUid);
}

export async function stopAllPreviews(): Promise<void> {
  const db = getDb();
  const rows = db.select().from(schema.previewServers).all();
  await Promise.all(rows.map((row) => stopPreview(row.taskUid)));
}

export async function stopPreviewsForProject(projectId: string): Promise<void> {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.previewServers)
    .where(eq(schema.previewServers.projectId, projectId))
    .all();
  await Promise.all(rows.map((row) => stopPreview(row.taskUid)));
}

export function attachPreviewToTask<T extends { uid: string }>(task: T): T & { preview: PreviewInfo } {
  return { ...task, preview: getPreviewStatus(task.uid) };
}
