import fs from 'fs';
import path from 'path';
import {
  WorkspaceDirEntry,
  WorkspaceDirListResponse,
  WorkspaceFileContentResponse,
} from '../../shared/schemas.js';
import { assertPathInWorkspace, normalizePath } from './files.js';
import { getProject, NotFoundError, ValidationError } from './tasks.js';

const MAX_PREVIEW_BYTES = 512 * 1024;

const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.pm-ai-worktrees',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'out',
  '.DS_Store',
  'Thumbs.db',
]);

function requireUsableProject(projectId: string) {
  const project = getProject(projectId);
  if (project.bindingStatus !== 'ok') {
    throw new ValidationError('workspace 不可用');
  }
  return project;
}

function normalizeRelativePath(relativePath: string | undefined): string {
  const raw = (relativePath ?? '').replace(/\\/g, '/').trim();
  if (!raw || raw === '.') return '';
  const cleaned = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) {
    throw new ValidationError('無效的路徑');
  }
  return parts.join('/');
}

function resolveInWorkspace(workspacePath: string, relativePath: string): string {
  const rel = normalizeRelativePath(relativePath);
  const absolute = path.resolve(workspacePath, rel || '.');
  try {
    assertPathInWorkspace(workspacePath, absolute);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : '路徑超出 workspace 範圍');
  }
  return absolute;
}

function assertRealInWorkspace(workspacePath: string, absolutePath: string): void {
  try {
    assertPathInWorkspace(workspacePath, absolutePath);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : '路徑超出 workspace 範圍');
  }
}

function toRelativePath(workspacePath: string, absolutePath: string): string {
  const rel = path.relative(workspacePath, absolutePath).replace(/\\/g, '/');
  return rel === '.' ? '' : rel;
}

function safeRealPath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  if (sample.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

export function listWorkspaceDir(
  projectId: string,
  relativePath?: string,
): WorkspaceDirListResponse {
  const project = requireUsableProject(projectId);
  const workspacePath = project.workspacePath;
  const rel = normalizeRelativePath(relativePath);
  const absolute = resolveInWorkspace(workspacePath, rel);

  if (!fs.existsSync(absolute)) {
    throw new NotFoundError('資料夾不存在');
  }

  const real = safeRealPath(absolute);
  if (!real) throw new NotFoundError('資料夾不存在');
  assertRealInWorkspace(workspacePath, real);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new NotFoundError('資料夾不存在');
  }
  if (!stat.isDirectory()) {
    throw new ValidationError('路徑不是資料夾');
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(real, { withFileTypes: true });
  } catch {
    throw new ValidationError('無法讀取資料夾');
  }

  const entries: WorkspaceDirEntry[] = [];

  for (const dirent of dirents) {
    if (IGNORED_NAMES.has(dirent.name)) continue;

    const childAbs = path.join(real, dirent.name);
    let childReal = childAbs;
    let childStat: fs.Stats;

    try {
      if (dirent.isSymbolicLink()) {
        const resolved = safeRealPath(childAbs);
        if (!resolved) continue;
        try {
          assertRealInWorkspace(workspacePath, resolved);
        } catch {
          continue;
        }
        childReal = resolved;
        childStat = fs.statSync(resolved);
      } else {
        childStat = fs.lstatSync(childAbs);
      }
    } catch {
      continue;
    }

    const type: 'file' | 'dir' = childStat.isDirectory() ? 'dir' : 'file';
    if (!childStat.isDirectory() && !childStat.isFile()) continue;

    const entry: WorkspaceDirEntry = {
      name: dirent.name,
      path: toRelativePath(workspacePath, path.join(absolute, dirent.name)),
      type,
    };
    if (type === 'file') {
      entry.size = childStat.size;
    }
    entry.mtime = childStat.mtime.toISOString();
    entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    path: rel,
    entries,
  };
}

export function readWorkspaceFile(
  projectId: string,
  relativePath: string,
): WorkspaceFileContentResponse {
  const project = requireUsableProject(projectId);
  const workspacePath = project.workspacePath;
  const rel = normalizeRelativePath(relativePath);
  if (!rel) {
    throw new ValidationError('需要 path 參數');
  }

  const absolute = resolveInWorkspace(workspacePath, rel);
  if (!fs.existsSync(absolute)) {
    throw new NotFoundError('檔案不存在');
  }

  const real = safeRealPath(absolute);
  if (!real) throw new NotFoundError('檔案不存在');
  assertRealInWorkspace(workspacePath, real);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new NotFoundError('檔案不存在');
  }
  if (stat.isDirectory()) {
    throw new ValidationError('路徑是資料夾，無法預覽');
  }
  if (!stat.isFile()) {
    throw new ValidationError('無法預覽此路徑');
  }

  const size = stat.size;
  if (size > MAX_PREVIEW_BYTES) {
    return {
      path: rel,
      content: null,
      encoding: null,
      size,
      binary: false,
      too_large: true,
    };
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(real);
  } catch {
    throw new ValidationError('無法讀取檔案');
  }

  if (isBinaryBuffer(buf)) {
    return {
      path: rel,
      content: null,
      encoding: null,
      size,
      binary: true,
      too_large: false,
    };
  }

  return {
    path: rel,
    content: buf.toString('utf-8'),
    encoding: 'utf-8',
    size,
    binary: false,
    too_large: false,
  };
}

export function normalizeWorkspaceRelativePath(relativePath: string | undefined): string {
  return normalizeRelativePath(relativePath);
}
