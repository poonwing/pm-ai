import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import matter from 'gray-matter';
import YAML from 'yaml';
import {
  TaskFrontmatter,
  TaskFrontmatterSchema,
  ProjectConfig,
  ProjectConfigSchema,
  ActivityAction,
  ActorType,
} from '../../shared/schemas.js';
import {
  getPmAiDir,
  getTasksDir,
  getActivityDir,
  getProjectConfigPath,
  getLocksDir,
  PM_AI_README,
  PM_AI_GITIGNORE,
} from '../paths.js';

export function computeContentHash(frontmatter: Record<string, unknown>, body: string): string {
  const normalized = JSON.stringify({ frontmatter, body: body.replace(/\r\n/g, '\n') });
  return 'sha256:' + crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

export function ensurePmAiStructure(workspacePath: string): void {
  const pmAiDir = getPmAiDir(workspacePath);
  fs.mkdirSync(getTasksDir(workspacePath), { recursive: true });
  fs.mkdirSync(getActivityDir(workspacePath), { recursive: true });
  fs.mkdirSync(getLocksDir(workspacePath), { recursive: true });
  fs.mkdirSync(path.join(pmAiDir, 'cache'), { recursive: true });

  const readmePath = path.join(pmAiDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, PM_AI_README, 'utf-8');
  }

  const gitignorePath = path.join(pmAiDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, PM_AI_GITIGNORE, 'utf-8');
  }
}

export function readProjectConfig(workspacePath: string): ProjectConfig | null {
  const configPath = getProjectConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw);
  return ProjectConfigSchema.parse(parsed);
}

export function writeProjectConfig(workspacePath: string, config: ProjectConfig): void {
  ensurePmAiStructure(workspacePath);
  const configPath = getProjectConfigPath(workspacePath);
  fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8');
}

export function readTaskFile(filePath: string): { frontmatter: TaskFrontmatter; body: string } {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const frontmatter = TaskFrontmatterSchema.parse(data);
  return { frontmatter, body: content.trim() };
}

export function writeTaskFile(
  filePath: string,
  frontmatter: TaskFrontmatter,
  body: string,
): void {
  const fm = { ...frontmatter };
  fm.content_hash = computeContentHash(fm as unknown as Record<string, unknown>, body);
  const content = matter.stringify(body, fm);
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function listTaskFiles(workspacePath: string): string[] {
  const tasksDir = getTasksDir(workspacePath);
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(tasksDir, f));
}

export function getActivityFilePath(workspacePath: string, date = new Date()): string {
  const yearMonth = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(getActivityDir(workspacePath), `${yearMonth}.jsonl`);
}

export interface ActivityEntry {
  id: string;
  at: string;
  task_id: string;
  actor: ActorType;
  actor_name?: string | null;
  action: ActivityAction;
  from_status?: string | null;
  to_status?: string | null;
  summary?: string | null;
  body?: string | null;
}

export function appendActivity(workspacePath: string, entry: ActivityEntry): void {
  ensurePmAiStructure(workspacePath);
  const filePath = getActivityFilePath(workspacePath);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

export function readActivities(
  workspacePath: string,
  taskId?: string,
  limit = 50,
): ActivityEntry[] {
  const activityDir = getActivityDir(workspacePath);
  if (!fs.existsSync(activityDir)) return [];

  const files = fs
    .readdirSync(activityDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse();

  const entries: ActivityEntry[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(activityDir, file), 'utf-8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const entry = JSON.parse(lines[i]) as ActivityEntry;
        if (!taskId || entry.task_id === taskId) {
          entries.push(entry);
        }
      } catch {
        // skip malformed lines
      }
    }
    if (entries.length >= limit) break;
  }
  return entries.slice(0, limit).reverse();
}

export function findGitRoot(dir: string): string | null {
  let current = path.resolve(dir);
  const root = path.parse(current).root;
  while (current !== root) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

export function validateWorkspacePath(workspacePath: string): {
  valid: boolean;
  error?: string;
} {
  const resolved = path.resolve(workspacePath);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return { valid: false, error: '不能綁定磁碟根目錄' };
  }
  if (!fs.existsSync(resolved)) {
    return { valid: false, error: '資料夾不存在' };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { valid: false, error: '路徑不是資料夾' };
  }
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return { valid: false, error: '資料夾沒有讀寫權限' };
  }
  return { valid: true };
}

export function assertPathInWorkspace(workspacePath: string, targetPath: string): void {
  const ws = path.resolve(workspacePath);
  const target = path.resolve(targetPath);
  if (!target.startsWith(ws + path.sep) && target !== ws) {
    throw new Error('路徑超出 workspace 範圍');
  }
}

/** Simple file-based write lock */
export class WriteLock {
  private lockPath: string;
  private workspacePath: string;
  private acquired = false;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.lockPath = path.join(getLocksDir(workspacePath), 'write.lock');
  }

  acquire(timeoutMs = 10000): boolean {
    ensurePmAiStructure(this.workspacePath);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
        this.acquired = true;
        return true;
      } catch {
        const stat = fs.existsSync(this.lockPath) ? fs.statSync(this.lockPath) : null;
        if (stat && Date.now() - stat.mtimeMs > timeoutMs) {
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            // ignore
          }
        }
        const waitUntil = Date.now() + 50;
        while (Date.now() < waitUntil) {
          /* wait */
        }
      }
    }
    return false;
  }

  release(): void {
    if (this.acquired && fs.existsSync(this.lockPath)) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // ignore
      }
      this.acquired = false;
    }
  }
}

export function withWriteLock<T>(workspacePath: string, fn: () => T): T {
  const lock = new WriteLock(workspacePath);
  if (!lock.acquire()) {
    throw new Error('無法取得寫入鎖，請稍後重試');
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}
