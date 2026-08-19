import { z } from 'zod';

export const TASK_STATUSES = [
  'draft',
  'todo',
  'in_progress',
  'done',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '草稿',
  todo: '待處理',
  in_progress: '處理中',
  done: '完成',
  cancelled: '取消',
};

export const BINDING_STATUSES = ['ok', 'missing', 'moved_unresolved', 'conflict'] as const;
export type BindingStatus = (typeof BINDING_STATUSES)[number];

export const ACTOR_TYPES = ['human', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const ACTIVITY_ACTIONS = [
  'created',
  'status_changed',
  'updated',
  'claimed',
  'unclaimed',
  'progress',
  'completed',
  'reviewed',
  'rejected',
  'commented',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export const ISOLATION_STATUSES = ['none', 'ready', 'failed', 'removed'] as const;
export type IsolationStatus = (typeof ISOLATION_STATUSES)[number];

export const PREVIEW_STATUSES = ['stopped', 'starting', 'running', 'error'] as const;
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

export const DEFAULT_PREVIEW_COMMAND = 'npm run dev';
export const DEFAULT_PREVIEW_INSTALL_COMMAND = 'npm install';
export const PREVIEW_BASE_PORT = 7500;

export const RejectionSchema = z.object({
  reason: z.string(),
  at: z.string(),
  by: z.enum(ACTOR_TYPES),
});

export const TaskFrontmatterSchema = z.object({
  id: z.string(),
  uid: z.string().uuid(),
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  version: z.number().int().positive(),
  human_reviewed: z.boolean().default(false),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable().optional(),
  created_by: z.enum(ACTOR_TYPES),
  updated_by: z.enum(ACTOR_TYPES),
  updated_by_name: z.string().nullable().optional(),
  claimed_by: z.string().nullable().optional(),
  claimed_at: z.string().nullable().optional(),
  goal: z.string().default(''),
  acceptance_criteria: z.string().default(''),
  constraints: z.string().default(''),
  agent_notes: z.string().default(''),
  result_note: z.string().default(''),
  artifacts: z.array(z.string()).default([]),
  rejections: z.array(RejectionSchema).default([]),
  content_hash: z.string().optional(),
  git_branch: z.string().nullable().optional().default(null),
  worktree_path: z.string().nullable().optional().default(null),
  isolation_base_sha: z.string().nullable().optional().default(null),
  isolation_status: z.enum(ISOLATION_STATUSES).optional().default('none'),
  isolation_error: z.string().nullable().optional().default(null),
  use_isolation: z.boolean().optional().default(false),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

export const ProjectConfigSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().default(''),
  schema_version: z.number().int().default(1),
  created_at: z.string(),
  status: z.enum(['active', 'archived']).default('active'),
  task_id_prefix: z.string().default('TASK'),
  next_task_seq: z.number().int().positive().default(1),
  preview_command: z.string().default(DEFAULT_PREVIEW_COMMAND),
  preview_install_command: z.string().default(DEFAULT_PREVIEW_INSTALL_COMMAND),
  preview_install_if_needed: z.boolean().default(true),
  preview_workdir: z.string().default(''),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const CreateProjectSchema = z.object({
  name: z.string().min(1),
  workspace_path: z.string().min(1),
  description: z.string().optional(),
});

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  archived: z.boolean().optional(),
  preview_command: z.string().min(1).optional(),
  preview_install_command: z.string().min(1).optional(),
  preview_install_if_needed: z.boolean().optional(),
  preview_workdir: z.string().optional(),
});

export const RelocateProjectSchema = z.object({
  workspace_path: z.string().min(1),
});

export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  goal: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  constraints: z.string().optional(),
  agent_notes: z.string().optional(),
  agent_name: z.string().min(1).optional(),
  use_isolation: z.boolean().optional().default(false),
});

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  goal: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  constraints: z.string().optional(),
  agent_notes: z.string().optional(),
  expected_version: z.number().int().positive(),
  use_isolation: z.boolean().optional(),
});

export const ClaimTaskSchema = z.object({
  agent_name: z.string().min(1),
  expected_version: z.number().int().positive(),
});

export const HeartbeatSchema = z.object({
  agent_name: z.string().min(1),
  lease_token: z.string().uuid(),
});

export const ProgressSchema = z.object({
  agent_name: z.string().min(1),
  lease_token: z.string().uuid(),
  summary: z.string().min(1),
});

export const CompleteTaskSchema = z.object({
  agent_name: z.string().min(1),
  lease_token: z.string().uuid(),
  result_note: z.string().min(1),
  artifacts: z.array(z.string()).default([]),
});

export const ReleaseTaskSchema = z.object({
  agent_name: z.string().min(1),
  lease_token: z.string().uuid(),
  reason: z.string().optional(),
});

export const RejectReviewSchema = z.object({
  reason: z.string().min(1),
});

export const CancelTaskSchema = z.object({
  reason: z.string().optional(),
});

export const CreateCommentSchema = z.object({
  body: z.string().min(1).max(8000),
  agent_name: z.string().min(1).optional(),
});

export const PORT = 7432;
export const LEASE_DURATION_MS = 15 * 60 * 1000;

/** Human-only transitions */
export const HUMAN_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['todo', 'cancelled'],
  todo: ['cancelled'],
  in_progress: ['cancelled'],
  done: ['todo'],
  cancelled: ['todo'],
};

/** Agent-only transitions */
export const AGENT_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: [],
  todo: ['in_progress'],
  in_progress: ['done', 'todo'],
  done: [],
  cancelled: [],
};

export function canTransition(
  from: TaskStatus,
  to: TaskStatus,
  actor: 'human' | 'agent',
): boolean {
  const map = actor === 'human' ? HUMAN_TRANSITIONS : AGENT_TRANSITIONS;
  return map[from]?.includes(to) ?? false;
}

export function isPendingReview(task: TaskFrontmatter): boolean {
  return task.status === 'done' && !task.human_reviewed;
}

export const CHANGE_FILE_STATUSES = ['A', 'M', 'D', 'R', '?'] as const;
export type ChangeFileStatus = (typeof CHANGE_FILE_STATUSES)[number];

export const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(CHANGE_FILE_STATUSES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
});

export const TaskChangesSummarySchema = z.object({
  mode: z.enum(['isolated', 'workspace', 'none']),
  base_sha: z.string().nullable(),
  head_sha: z.string().nullable(),
  base_label: z.string(),
  head_label: z.string(),
  has_uncommitted: z.boolean(),
  warning: z.string().optional(),
  files: z.array(ChangedFileSchema),
  stats: z.object({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
});

export type TaskChangesSummary = z.infer<typeof TaskChangesSummarySchema>;

export const FileDiffResponseSchema = z.object({
  path: z.string(),
  status: z.string(),
  patch: z.string(),
  too_large: z.boolean(),
  old_label: z.string(),
  new_label: z.string(),
  binary: z.boolean(),
});

export type FileDiffResponse = z.infer<typeof FileDiffResponseSchema>;

export function needsHumanAttention(task: TaskFrontmatter): boolean {
  if (task.status === 'draft') return true;
  if (isPendingReview(task)) return true;
  return false;
}
