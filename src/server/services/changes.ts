import {
  assertRepoRelativePath,
  ChangedFileEntry,
  getBranchTipSha,
  getExecutionPath,
  getFileContentAtRef,
  getFileDiffAgainstHead,
  getFileDiffBetween,
  getHeadSha,
  getWorkingTreeFileContent,
  listChangedFilesBetween,
  listDirtyFiles,
  mergeChangedFiles,
  shortSha,
  worktreePathExists,
} from './git.js';
import { getProject, getTask, ValidationError } from './tasks.js';
import type {
  FileContentResponse,
  FileDiffResponse,
  TaskChangesSummary,
} from '../../shared/schemas.js';
import fs from 'fs';

const MAX_PATCH_BYTES = 500 * 1024;
const MAX_PATCH_LINES = 5000;
const MAX_FILE_BYTES = 500 * 1024;

/** Allow viewing while Agent is working or after completion (incl. already reviewed). */
function assertChangesAccess(task: { status: string }) {
  if (task.status !== 'done' && task.status !== 'in_progress') {
    throw new ValidationError('僅進行中或已完成任務可查看程式碼變更');
  }
}

function summarizeFiles(files: ChangedFileEntry[]) {
  return {
    files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

function emptySummary(mode: TaskChangesSummary['mode'], warning?: string): TaskChangesSummary {
  return {
    mode,
    base_sha: null,
    head_sha: null,
    base_label: '',
    head_label: '',
    has_uncommitted: false,
    warning,
    files: [],
    stats: { files: 0, additions: 0, deletions: 0 },
  };
}

/**
 * Resolve where uncommitted (dirty) files for this task live.
 * Prefer the task worktree when it still exists on disk — same cwd Runner uses.
 */
function resolveDirtyRepoPath(
  gitRoot: string,
  workspacePath: string,
  task: {
    use_isolation?: boolean | null;
    worktree_path?: string | null;
    isolation_status?: string | null;
    execution_path?: string | null;
  },
): string | null {
  const wt = task.worktree_path?.trim();
  if (wt && fs.existsSync(wt) && worktreePathExists(gitRoot, wt)) {
    return wt;
  }
  const exec = String(
    task.execution_path ||
      getExecutionPath(workspacePath, {
        use_isolation: task.use_isolation,
        worktree_path: task.worktree_path,
        isolation_status: task.isolation_status,
      }),
  );
  if (exec && exec !== workspacePath && fs.existsSync(exec)) {
    return exec;
  }
  return null;
}

/**
 * Task has a dedicated branch + base: review against that branch tip,
 * regardless of whether the worktree is still "ready".
 */
function hasTaskBranchContext(task: {
  git_branch?: string | null;
  isolation_base_sha?: string | null;
}): boolean {
  return Boolean(task.git_branch?.trim() && task.isolation_base_sha?.trim());
}

export function getTaskChanges(projectId: string, taskId: string): TaskChangesSummary {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);
  assertChangesAccess(task);

  if (!project.gitRoot) {
    return emptySummary('none', '此專案未偵測到 git，無法顯示 diff。請參考 Agent 回報的 artifacts。');
  }

  const gitRoot = project.gitRoot;
  const workspacePath = project.workspacePath;

  // Prefer task branch (same delivery context as Runner), even if worktree was removed
  // or isolation_status is no longer "ready".
  if (hasTaskBranchContext(task)) {
    const baseSha = task.isolation_base_sha!;
    const branch = task.git_branch!;
    const headSha = getBranchTipSha(gitRoot, branch);
    const committed = headSha ? listChangedFilesBetween(gitRoot, baseSha, headSha) : [];

    let dirtyFiles: ChangedFileEntry[] = [];
    let hasUncommitted = false;
    const warnings: string[] = [];

    if (!headSha) {
      warnings.push(`找不到任務分支 tip：${branch}。僅能依 worktree 未提交變更（若有）審查。`);
    }

    const dirtyPath = resolveDirtyRepoPath(gitRoot, workspacePath, task);
    if (dirtyPath) {
      const dirty = listDirtyFiles(dirtyPath);
      dirtyFiles = dirty.files;
      hasUncommitted = dirty.hasUncommitted;
    } else if (task.worktree_path && task.isolation_status !== 'ready') {
      warnings.push(
        `worktree 不可用（isolation_status=${task.isolation_status ?? 'unknown'}），僅顯示已 commit 到 ${branch} 的變更。`,
      );
    }

    const files = mergeChangedFiles(committed, dirtyFiles);
    return {
      mode: 'isolated',
      base_sha: baseSha,
      head_sha: headSha,
      base_label: `建立隔離時 (${shortSha(baseSha)})`,
      head_label: headSha
        ? `${branch} (${shortSha(headSha)})${hasUncommitted ? ' + 未提交' : ''}`
        : branch,
      has_uncommitted: hasUncommitted,
      warning: warnings.length ? warnings.join(' ') : undefined,
      files,
      stats: summarizeFiles(files),
    };
  }

  // Worktree exists but no branch metadata — still prefer that cwd over main workspace
  const dirtyPath = resolveDirtyRepoPath(gitRoot, workspacePath, task);
  if (dirtyPath) {
    const dirty = listDirtyFiles(dirtyPath);
    return {
      mode: 'workspace',
      base_sha: getHeadSha(dirtyPath),
      head_sha: null,
      base_label: 'HEAD',
      head_label: '任務 worktree（未提交）',
      has_uncommitted: dirty.hasUncommitted,
      warning: '任務無 git_branch/isolation_base_sha，顯示的是任務 worktree 相對其 HEAD 的變更。',
      files: dirty.files,
      stats: summarizeFiles(dirty.files),
    };
  }

  const headSha = getHeadSha(gitRoot);
  const dirty = listDirtyFiles(gitRoot);
  return {
    mode: 'workspace',
    base_sha: headSha,
    head_sha: null,
    base_label: headSha ? `HEAD (${shortSha(headSha)})` : 'HEAD',
    head_label: '主 workspace（未提交）',
    has_uncommitted: dirty.hasUncommitted,
    warning:
      '此任務無隔離分支資訊，顯示的是主 workspace 相對 HEAD 的變更，可能包含與本任務無關的改動，僅供參考。',
    files: dirty.files,
    stats: summarizeFiles(dirty.files),
  };
}

function truncatePatch(patch: string): { patch: string; tooLarge: boolean } {
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    return { patch: '', tooLarge: true };
  }
  const lines = patch.split('\n');
  if (lines.length > MAX_PATCH_LINES) {
    return { patch: lines.slice(0, MAX_PATCH_LINES).join('\n') + '\n… (已截斷)', tooLarge: true };
  }
  return { patch, tooLarge: false };
}

function truncateContent(content: string): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES) {
    return { content, truncated: false };
  }
  let cut = content;
  while (Buffer.byteLength(cut, 'utf8') > MAX_FILE_BYTES) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return { content: `${cut}\n… (已截斷)`, truncated: true };
}

export function getTaskFileDiff(
  projectId: string,
  taskId: string,
  rawPath: string,
): FileDiffResponse {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);
  assertChangesAccess(task);

  const filePath = assertRepoRelativePath(rawPath);

  if (!project.gitRoot) {
    throw new ValidationError('此專案未偵測到 git');
  }

  const gitRoot = project.gitRoot;
  const workspacePath = project.workspacePath;

  let patch = '';
  let binary = false;
  let oldLabel = '';
  let newLabel = '';
  let status = 'M';

  const summary = getTaskChanges(projectId, taskId);
  const fileEntry = summary.files.find((f) => f.path === filePath);
  if (fileEntry) status = fileEntry.status;

  if (hasTaskBranchContext(task)) {
    const baseSha = task.isolation_base_sha!;
    const branch = task.git_branch!;
    const headSha = getBranchTipSha(gitRoot, branch);
    oldLabel = `base (${shortSha(baseSha)})`;
    newLabel = headSha ? `${branch} (${shortSha(headSha)})` : branch;

    if (headSha) {
      const committed = getFileDiffBetween(gitRoot, baseSha, headSha, filePath);
      patch = committed.patch;
      binary = committed.binary || (fileEntry?.binary ?? false);
    }

    // Prefer worktree dirty when committed patch is empty (e.g. untracked / uncommitted)
    if (!patch) {
      const dirtyPath = resolveDirtyRepoPath(gitRoot, workspacePath, task);
      if (dirtyPath) {
        const dirty = getFileDiffAgainstHead(dirtyPath, filePath);
        patch = dirty.patch;
        binary = binary || dirty.binary;
        oldLabel = 'HEAD';
        newLabel = '任務 worktree';
      }
    }
  } else {
    const dirtyPath = resolveDirtyRepoPath(gitRoot, workspacePath, task) ?? gitRoot;
    const headSha = getHeadSha(dirtyPath);
    oldLabel = headSha ? `HEAD (${shortSha(headSha)})` : 'HEAD';
    newLabel = dirtyPath === gitRoot ? '主 workspace' : '任務 worktree';
    const dirty = getFileDiffAgainstHead(dirtyPath, filePath);
    patch = dirty.patch;
    binary = dirty.binary || (fileEntry?.binary ?? false);
  }

  if (binary) {
    return {
      path: filePath,
      status,
      patch: '',
      too_large: true,
      old_label: oldLabel,
      new_label: newLabel,
      binary: true,
    };
  }

  const { patch: finalPatch, tooLarge } = truncatePatch(patch);
  return {
    path: filePath,
    status,
    patch: finalPatch,
    too_large: tooLarge,
    old_label: oldLabel,
    new_label: newLabel,
    binary: false,
  };
}

/**
 * Read the "after" side of a changed file (worktree preferred, else branch tip).
 * For deleted files, falls back to the base / HEAD content.
 */
export function getTaskFileContent(
  projectId: string,
  taskId: string,
  rawPath: string,
): FileContentResponse {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);
  assertChangesAccess(task);

  const filePath = assertRepoRelativePath(rawPath);

  if (!project.gitRoot) {
    throw new ValidationError('此專案未偵測到 git');
  }

  const gitRoot = project.gitRoot;
  const workspacePath = project.workspacePath;
  const summary = getTaskChanges(projectId, taskId);
  const fileEntry = summary.files.find((f) => f.path === filePath);
  const status = fileEntry?.status ?? 'M';

  let content = '';
  let binary = false;
  let missing = false;
  let label = '';
  let from: FileContentResponse['from'] = 'worktree';

  const dirtyPath = resolveDirtyRepoPath(gitRoot, workspacePath, task);

  if (status === 'D') {
    // Show pre-delete content
    if (hasTaskBranchContext(task) && task.isolation_base_sha) {
      const base = getFileContentAtRef(gitRoot, task.isolation_base_sha, filePath);
      content = base.content;
      binary = base.binary;
      missing = base.missing;
      label = `base (${shortSha(task.isolation_base_sha)})`;
      from = 'base';
    } else {
      const repo = dirtyPath ?? gitRoot;
      const headSha = getHeadSha(repo);
      if (headSha) {
        const head = getFileContentAtRef(repo, headSha, filePath);
        content = head.content;
        binary = head.binary;
        missing = head.missing;
        label = `HEAD (${shortSha(headSha)})`;
        from = 'head';
      } else {
        missing = true;
      }
    }
  } else {
    // Prefer live worktree
    if (dirtyPath) {
      const wt = getWorkingTreeFileContent(dirtyPath, filePath);
      if (!wt.missing) {
        content = wt.content;
        binary = wt.binary;
        label = dirtyPath === gitRoot ? '主 workspace' : '任務 worktree';
        from = 'worktree';
      } else {
        missing = true;
      }
    }

    if ((missing || !content) && !binary && hasTaskBranchContext(task)) {
      const headSha = getBranchTipSha(gitRoot, task.git_branch!);
      if (headSha) {
        const tip = getFileContentAtRef(gitRoot, headSha, filePath);
        if (!tip.missing) {
          content = tip.content;
          binary = tip.binary;
          missing = false;
          label = `${task.git_branch} (${shortSha(headSha)})`;
          from = 'branch';
        }
      }
    }

    if ((missing || (!content && !binary)) && !hasTaskBranchContext(task)) {
      const repo = dirtyPath ?? gitRoot;
      const wt = getWorkingTreeFileContent(repo, filePath);
      content = wt.content;
      binary = wt.binary;
      missing = wt.missing;
      label = repo === gitRoot ? '主 workspace' : '任務 worktree';
      from = 'worktree';
    }
  }

  if (binary) {
    return {
      path: filePath,
      status,
      content: '',
      truncated: false,
      binary: true,
      missing: false,
      label: label || filePath,
      from,
    };
  }

  if (missing) {
    return {
      path: filePath,
      status,
      content: '',
      truncated: false,
      binary: false,
      missing: true,
      label: label || filePath,
      from,
    };
  }

  const { content: finalContent, truncated } = truncateContent(content);
  return {
    path: filePath,
    status,
    content: finalContent,
    truncated,
    binary: false,
    missing: false,
    label: label || filePath,
    from,
  };
}
