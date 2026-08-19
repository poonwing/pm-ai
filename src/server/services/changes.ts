import {
  assertRepoRelativePath,
  ChangedFileEntry,
  getBranchTipSha,
  getFileDiffAgainstHead,
  getFileDiffBetween,
  getHeadSha,
  listChangedFilesBetween,
  listDirtyFiles,
  mergeChangedFiles,
  shortSha,
} from './git.js';
import { getProject, getTask, ValidationError } from './tasks.js';
import type { FileDiffResponse, TaskChangesSummary } from '../../shared/schemas.js';

const MAX_PATCH_BYTES = 500 * 1024;
const MAX_PATCH_LINES = 5000;

function assertReviewAccess(task: {
  status: string;
  human_reviewed?: boolean;
  humanReviewed?: boolean;
}) {
  const reviewed = task.human_reviewed ?? task.humanReviewed ?? false;
  if (task.status !== 'done' || reviewed) {
    throw new ValidationError('僅待驗收任務可查看程式碼變更');
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

export function getTaskChanges(projectId: string, taskId: string): TaskChangesSummary {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);
  assertReviewAccess(task);

  if (!project.gitRoot) {
    return emptySummary('none', '此專案未偵測到 git，無法顯示 diff。請參考 Agent 回報的 artifacts。');
  }

  const gitRoot = project.gitRoot;
  const isolated =
    task.use_isolation &&
    task.isolation_status === 'ready' &&
    !!task.git_branch &&
    !!task.isolation_base_sha;

  if (isolated) {
    const baseSha = task.isolation_base_sha!;
    const branch = task.git_branch!;
    const headSha = getBranchTipSha(gitRoot, branch);
    const committed = headSha ? listChangedFilesBetween(gitRoot, baseSha, headSha) : [];

    let dirtyFiles: ChangedFileEntry[] = [];
    let hasUncommitted = false;
    if (task.worktree_path) {
      const dirty = listDirtyFiles(task.worktree_path);
      dirtyFiles = dirty.files;
      hasUncommitted = dirty.hasUncommitted;
    }

    const files = mergeChangedFiles(committed, dirtyFiles);
    return {
      mode: 'isolated',
      base_sha: baseSha,
      head_sha: headSha,
      base_label: `建立隔離時 (${shortSha(baseSha)})`,
      head_label: headSha ? `${branch} (${shortSha(headSha)})` : branch,
      has_uncommitted: hasUncommitted,
      files,
      stats: summarizeFiles(files),
    };
  }

  const headSha = getHeadSha(gitRoot);
  const dirty = listDirtyFiles(gitRoot);
  return {
    mode: 'workspace',
    base_sha: headSha,
    head_sha: null,
    base_label: headSha ? `HEAD (${shortSha(headSha)})` : 'HEAD',
    head_label: '工作區（未提交）',
    has_uncommitted: dirty.hasUncommitted,
    warning:
      '此任務未啟用 Git 隔離，顯示的是主 workspace 相對 HEAD 的變更，可能包含與本任務無關的改動，僅供參考。',
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

export function getTaskFileDiff(
  projectId: string,
  taskId: string,
  rawPath: string,
): FileDiffResponse {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);
  assertReviewAccess(task);

  const filePath = assertRepoRelativePath(rawPath);

  if (!project.gitRoot) {
    throw new ValidationError('此專案未偵測到 git');
  }

  const gitRoot = project.gitRoot;
  const isolated =
    task.use_isolation &&
    task.isolation_status === 'ready' &&
    !!task.git_branch &&
    !!task.isolation_base_sha;

  let patch = '';
  let binary = false;
  let oldLabel = '';
  let newLabel = '';
  let status = 'M';

  const summary = getTaskChanges(projectId, taskId);
  const fileEntry = summary.files.find((f) => f.path === filePath);
  if (fileEntry) status = fileEntry.status;

  if (isolated) {
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

    if (!patch && task.worktree_path) {
      const dirty = getFileDiffAgainstHead(task.worktree_path, filePath);
      patch = dirty.patch;
      binary = binary || dirty.binary;
      oldLabel = 'HEAD';
      newLabel = '工作區';
    }
  } else {
    const headSha = getHeadSha(gitRoot);
    oldLabel = headSha ? `HEAD (${shortSha(headSha)})` : 'HEAD';
    newLabel = '工作區';
    const dirty = getFileDiffAgainstHead(gitRoot, filePath);
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
