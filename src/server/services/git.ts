import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runGit(gitRoot: string, args: string[]): GitCommandResult {
  try {
    const stdout = execFileSync('git', ['-C', gitRoot, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const stdout = e.stdout != null ? String(e.stdout).trim() : '';
    const stderr = e.stderr != null ? String(e.stderr).trim() : (e.message ?? '');
    return {
      stdout,
      stderr,
      code: typeof e.status === 'number' ? e.status : 1,
    };
  }
}

export function taskBranchName(taskId: string): string {
  return `pm-ai/${taskId}`;
}

export function worktreePathForTask(gitRoot: string, projectId: string, taskId: string): string {
  const parent = path.dirname(gitRoot);
  const shortId = projectId.replace(/-/g, '').slice(0, 8);
  return path.join(parent, '.pm-ai-worktrees', shortId, taskId);
}

export function getHeadSha(gitRoot: string): string | null {
  const result = runGit(gitRoot, ['rev-parse', 'HEAD']);
  if (result.code !== 0) return null;
  return result.stdout;
}

export function resolveBaseSha(gitRoot: string): string {
  const originHead = runGit(gitRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (originHead.code === 0) {
    const remoteRef = originHead.stdout.replace('refs/remotes/', '');
    const sha = runGit(gitRoot, ['rev-parse', remoteRef]);
    if (sha.code === 0) return sha.stdout;
  }

  for (const branch of ['main', 'master']) {
    const sha = runGit(gitRoot, ['rev-parse', branch]);
    if (sha.code === 0) return sha.stdout;
  }

  const head = getHeadSha(gitRoot);
  if (head) return head;
  throw new Error('無法解析 git base commit');
}

function branchExists(gitRoot: string, branch: string): boolean {
  const result = runGit(gitRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return result.code === 0;
}

function worktreeRegistered(gitRoot: string, worktreePath: string): boolean {
  const resolved = path.resolve(worktreePath);
  const list = runGit(gitRoot, ['worktree', 'list', '--porcelain']);
  if (list.code !== 0) return false;
  return list.stdout.split('\n').some((line) => {
    if (!line.startsWith('worktree ')) return false;
    return path.resolve(line.slice('worktree '.length)) === resolved;
  });
}

export interface EnsureIsolationResult {
  git_branch: string;
  worktree_path: string;
  isolation_base_sha: string;
  isolation_status: 'ready' | 'failed';
  isolation_error?: string;
}

export interface ExistingIsolation {
  git_branch?: string | null;
  worktree_path?: string | null;
  isolation_status?: string | null;
  isolation_base_sha?: string | null;
}

export function ensureTaskWorktree(
  gitRoot: string,
  projectId: string,
  taskId: string,
  existing: ExistingIsolation = {},
): EnsureIsolationResult {
  const branch = existing.git_branch || taskBranchName(taskId);
  const worktreePath = existing.worktree_path || worktreePathForTask(gitRoot, projectId, taskId);

  if (
    existing.isolation_status === 'ready' &&
    existing.worktree_path &&
    fs.existsSync(existing.worktree_path) &&
    worktreeRegistered(gitRoot, existing.worktree_path)
  ) {
    return {
      git_branch: branch,
      worktree_path: existing.worktree_path,
      isolation_base_sha: existing.isolation_base_sha || resolveBaseSha(gitRoot),
      isolation_status: 'ready',
    };
  }

  try {
    const baseSha = resolveBaseSha(gitRoot);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    if (fs.existsSync(worktreePath)) {
      if (worktreeRegistered(gitRoot, worktreePath)) {
        return {
          git_branch: branch,
          worktree_path: worktreePath,
          isolation_base_sha: baseSha,
          isolation_status: 'ready',
        };
      }
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }

    const addArgs = branchExists(gitRoot, branch)
      ? ['worktree', 'add', worktreePath, branch]
      : ['worktree', 'add', '-b', branch, worktreePath, baseSha];

    const addResult = runGit(gitRoot, addArgs);
    if (addResult.code !== 0) {
      return {
        git_branch: branch,
        worktree_path: worktreePath,
        isolation_base_sha: baseSha,
        isolation_status: 'failed',
        isolation_error: addResult.stderr || addResult.stdout || 'git worktree add 失敗',
      };
    }

    return {
      git_branch: branch,
      worktree_path: worktreePath,
      isolation_base_sha: baseSha,
      isolation_status: 'ready',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      git_branch: branch,
      worktree_path: worktreePath,
      isolation_base_sha: '',
      isolation_status: 'failed',
      isolation_error: message,
    };
  }
}

export function removeTaskWorktree(
  gitRoot: string,
  worktreePath: string,
): { ok: boolean; error?: string } {
  if (!worktreePath) {
    return { ok: true };
  }

  const result = runGit(gitRoot, ['worktree', 'remove', worktreePath, '--force']);
  if (result.code !== 0) {
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        runGit(gitRoot, ['worktree', 'prune']);
        return { ok: true };
      } catch {
        return { ok: false, error: result.stderr || result.stdout || '無法移除 worktree' };
      }
    }
    runGit(gitRoot, ['worktree', 'prune']);
    return { ok: true };
  }

  runGit(gitRoot, ['worktree', 'prune']);
  return { ok: true };
}

export function openInCursor(targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('cursor', [targetPath], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}

export function getExecutionPath(
  workspacePath: string,
  isolation: {
    worktree_path?: string | null;
    isolation_status?: string | null;
    use_isolation?: boolean | null;
  },
): string {
  if (
    isolation.use_isolation &&
    isolation.worktree_path &&
    isolation.isolation_status === 'ready'
  ) {
    return isolation.worktree_path;
  }
  return workspacePath;
}

export type ChangeFileStatus = 'A' | 'M' | 'D' | 'R' | '?';

export interface ChangedFileEntry {
  path: string;
  status: ChangeFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function getBranchTipSha(gitRoot: string, branch: string): string | null {
  const result = runGit(gitRoot, ['rev-parse', `refs/heads/${branch}`]);
  if (result.code !== 0) return null;
  return result.stdout;
}

function parseNumStatLine(line: string): { additions: number; deletions: number; path: string; binary: boolean } | null {
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const [addRaw, delRaw, ...pathParts] = parts;
  const filePath = pathParts.join('\t');
  if (!filePath) return null;
  const binary = addRaw === '-' && delRaw === '-';
  return {
    additions: binary ? 0 : parseInt(addRaw, 10) || 0,
    deletions: binary ? 0 : parseInt(delRaw, 10) || 0,
    path: filePath.replace(/\\/g, '/'),
    binary,
  };
}

function parseNameStatusLine(line: string): { status: ChangeFileStatus; path: string } | null {
  const tab = line.indexOf('\t');
  if (tab === -1) return null;
  const code = line.slice(0, tab);
  const rest = line.slice(tab + 1);
  let status: ChangeFileStatus = 'M';
  let filePath = rest;
  if (code.startsWith('R') || code.startsWith('C')) {
    status = 'R';
    const arrow = rest.indexOf('\t');
    filePath = arrow === -1 ? rest : rest.slice(arrow + 1);
  } else if (code === 'A') status = 'A';
  else if (code === 'D') status = 'D';
  else if (code === 'M') status = 'M';
  else if (code === '??') status = '?';
  else status = 'M';
  return { status, path: filePath.replace(/\\/g, '/').replace(/^"+|"+$/g, '') };
}

export function listChangedFilesBetween(gitRoot: string, base: string, head: string): ChangedFileEntry[] {
  const numstat = runGit(gitRoot, ['diff', '--numstat', `${base}..${head}`]);
  const nameStatus = runGit(gitRoot, ['diff', '--name-status', `${base}..${head}`]);
  if (numstat.code !== 0 && nameStatus.code !== 0) return [];

  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseNumStatLine(line);
    if (parsed) {
      stats.set(parsed.path, {
        additions: parsed.additions,
        deletions: parsed.deletions,
        binary: parsed.binary,
      });
    }
  }

  const files: ChangedFileEntry[] = [];
  for (const line of nameStatus.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseNameStatusLine(line);
    if (!parsed) continue;
    const stat = stats.get(parsed.path);
    files.push({
      path: parsed.path,
      status: parsed.status,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
    });
  }
  return files;
}

export function listDirtyFiles(repoPath: string): { files: ChangedFileEntry[]; hasUncommitted: boolean } {
  const status = runGit(repoPath, ['status', '--porcelain']);
  if (status.code !== 0 || !status.stdout.trim()) {
    return { files: [], hasUncommitted: false };
  }

  const numstatUnstaged = runGit(repoPath, ['diff', '--numstat', 'HEAD']);
  const numstatStaged = runGit(repoPath, ['diff', '--cached', '--numstat', 'HEAD']);
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();

  for (const result of [numstatUnstaged, numstatStaged]) {
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseNumStatLine(line);
      if (!parsed) continue;
      const existing = stats.get(parsed.path);
      stats.set(parsed.path, {
        additions: (existing?.additions ?? 0) + parsed.additions,
        deletions: (existing?.deletions ?? 0) + parsed.deletions,
        binary: parsed.binary || (existing?.binary ?? false),
      });
    }
  }

  const files: ChangedFileEntry[] = [];
  for (const line of status.stdout.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop()!.trim();
    }
    filePath = filePath.replace(/\\/g, '/');
    let fileStatus: ChangeFileStatus = 'M';
    if (code.includes('?')) fileStatus = '?';
    else if (code.includes('A')) fileStatus = 'A';
    else if (code.includes('D')) fileStatus = 'D';
    else if (code.includes('R')) fileStatus = 'R';

    const stat = stats.get(filePath);
    files.push({
      path: filePath,
      status: fileStatus,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
    });
  }

  return { files, hasUncommitted: files.length > 0 };
}

export function mergeChangedFiles(primary: ChangedFileEntry[], secondary: ChangedFileEntry[]): ChangedFileEntry[] {
  const map = new Map<string, ChangedFileEntry>();
  for (const f of primary) map.set(f.path, { ...f });
  for (const f of secondary) {
    const existing = map.get(f.path);
    if (existing) {
      map.set(f.path, {
        ...existing,
        status: f.status === '?' ? existing.status : f.status,
        additions: Math.max(existing.additions, f.additions),
        deletions: Math.max(existing.deletions, f.deletions),
        binary: existing.binary || f.binary,
      });
    } else {
      map.set(f.path, { ...f });
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function getFileDiffBetween(
  gitRoot: string,
  base: string,
  head: string,
  filePath: string,
): { patch: string; binary: boolean } {
  const result = runGit(gitRoot, ['diff', `${base}..${head}`, '--', filePath]);
  const patch = result.stdout;
  const binary = patch.includes('Binary files ') || (result.code !== 0 && !patch);
  return { patch, binary };
}

export function getFileDiffAgainstHead(repoPath: string, filePath: string): { patch: string; binary: boolean } {
  const staged = runGit(repoPath, ['diff', '--cached', 'HEAD', '--', filePath]);
  const unstaged = runGit(repoPath, ['diff', 'HEAD', '--', filePath]);
  const patch = [staged.stdout, unstaged.stdout].filter(Boolean).join('\n');
  const binary = patch.includes('Binary files ');
  return { patch, binary };
}

export function assertRepoRelativePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error('無效的檔案路徑');
  }
  return normalized;
}

export interface LocalBranchInfo {
  name: string;
  worktreePath: string | null;
  checkedOutHere: boolean;
}

function parseWorktreeBranches(gitRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  const list = runGit(gitRoot, ['worktree', 'list', '--porcelain']);
  if (list.code !== 0) return map;

  let currentWorktree = '';
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentWorktree = path.resolve(line.slice('worktree '.length));
      continue;
    }
    if (line.startsWith('branch ') && currentWorktree) {
      const ref = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      map.set(ref, currentWorktree);
    }
  }
  return map;
}

export function assertBranchName(branch: string): string {
  const name = branch.trim();
  if (!name || name.includes('..') || name.startsWith('/') || name.includes('\\')) {
    throw new Error('無效的分支名稱');
  }
  if (name.startsWith('refs/') || name.includes('refs/heads/')) {
    throw new Error('請使用本地分支短名稱');
  }
  return name;
}

export function getCurrentBranch(gitRoot: string): string | null {
  const result = runGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.code !== 0) return null;
  if (result.stdout === 'HEAD') return null;
  return result.stdout;
}

export function hasUncommittedChanges(gitRoot: string): boolean {
  const result = runGit(gitRoot, ['status', '--porcelain']);
  return result.code === 0 && result.stdout.trim().length > 0;
}

export function listLocalBranches(gitRoot: string): LocalBranchInfo[] {
  const refs = runGit(gitRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (refs.code !== 0) return [];

  const worktreeByBranch = parseWorktreeBranches(gitRoot);
  const root = path.resolve(gitRoot);

  return refs.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const wt = worktreeByBranch.get(name) ?? null;
      const checkedOutHere = wt !== null && path.resolve(wt) === root;
      const worktreePath =
        wt !== null && path.resolve(wt) !== root ? wt : null;
      return { name, worktreePath, checkedOutHere };
    });
}

export function checkoutBranch(
  gitRoot: string,
  branch: string,
): { ok: true; branch: string } | { ok: false; error: string } {
  const name = assertBranchName(branch);
  const branches = listLocalBranches(gitRoot);
  const info = branches.find((b) => b.name === name);
  if (!info) {
    return { ok: false, error: `本地找不到分支：${name}` };
  }
  if (info.worktreePath) {
    return {
      ok: false,
      error: `分支 ${name} 已在 worktree 中使用：${info.worktreePath}`,
    };
  }
  if (info.checkedOutHere) {
    return { ok: true, branch: name };
  }

  const result = runGit(gitRoot, ['switch', name]);
  if (result.code !== 0) {
    const msg = result.stderr || result.stdout || 'git switch 失敗';
    if (/already checked out/i.test(msg)) {
      return { ok: false, error: `分支 ${name} 已在其他 worktree 中 checkout` };
    }
    return { ok: false, error: msg };
  }
  return { ok: true, branch: name };
}
