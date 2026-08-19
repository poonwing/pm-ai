import {
  checkoutBranch,
  getCurrentBranch,
  hasUncommittedChanges,
  listLocalBranches,
} from './git.js';
import { getProject, ValidationError } from './tasks.js';
import type { WorkspaceGitStatus } from '../../shared/schemas.js';

export function getWorkspaceGitStatus(projectId: string): WorkspaceGitStatus {
  const project = getProject(projectId);
  if (!project.gitRoot) {
    return {
      available: false,
      git_root: null,
      current_branch: null,
      dirty: false,
      branches: [],
    };
  }

  const gitRoot = project.gitRoot;
  return {
    available: true,
    git_root: gitRoot,
    current_branch: getCurrentBranch(gitRoot),
    dirty: hasUncommittedChanges(gitRoot),
    branches: listLocalBranches(gitRoot).map((b) => ({
      name: b.name,
      worktree_path: b.worktreePath,
      selectable: !b.worktreePath,
      current: b.checkedOutHere,
    })),
  };
}

export function checkoutWorkspaceBranch(projectId: string, branch: string) {
  const project = getProject(projectId);
  if (!project.gitRoot) {
    throw new ValidationError('此專案未偵測到 git 倉庫');
  }

  const result = checkoutBranch(project.gitRoot, branch);
  if (!result.ok) {
    throw new ValidationError(result.error);
  }

  return getWorkspaceGitStatus(projectId);
}
