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

export const ACTOR_TYPES = ['human', 'agent', 'system', 'orchestrator'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const RUN_MODES = ['manual', 'auto'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const AGENT_ROLES = [
  'orchestrator',
  'researcher',
  'analyst',
  'designer',
  'developer',
  'tester',
  'reviewer',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number] | (string & {});

export const STAFF_STATUSES = ['idle', 'working', 'blocked', 'retired'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

export const PROMPT_SOURCES = [
  'system_default',
  'orchestrator_generated',
  'orchestrator_edited',
  'human_written',
  'human_edited',
] as const;
export type PromptSource = (typeof PROMPT_SOURCES)[number];

export const AUTO_RUN_STATUSES = [
  'running',
  'paused',
  'awaiting_human',
  'completed',
  'stopped',
] as const;
export type AutoRunStatus = (typeof AUTO_RUN_STATUSES)[number];

export const DECISION_STATUSES = ['open', 'resolved', 'cancelled'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Free-text decision answer; requires a non-empty `note` on resolve. */
export const CUSTOM_DECISION_OPTION_ID = 'custom';

export const REVIEWER_TYPES = ['human', 'agent', 'orchestrator', 'none'] as const;
export type ReviewerType = (typeof REVIEWER_TYPES)[number];

export const TASK_REVIEW_STATUSES = [
  'none',
  'pending',
  'approved',
  'rejected',
] as const;
export type TaskReviewStatus = (typeof TASK_REVIEW_STATUSES)[number];

export const TaskReviewSchema = z.object({
  required: z.boolean().default(true),
  reviewer_type: z.enum(REVIEWER_TYPES).default('human'),
  reviewer_agent_id: z.string().nullable().optional().default(null),
  status: z.enum(TASK_REVIEW_STATUSES).default('none'),
  note: z.string().default(''),
});
export type TaskReview = z.infer<typeof TaskReviewSchema>;

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
  merged_into: z.string().nullable().optional().default(null),
  merged_at: z.string().nullable().optional().default(null),
  assignee_agent_id: z.string().nullable().optional().default(null),
  assignee_name: z.string().nullable().optional().default(null),
  queue_order: z.number().int().nullable().optional().default(null),
  review: TaskReviewSchema.optional().default({
    required: true,
    reviewer_type: 'human',
    reviewer_agent_id: null,
    status: 'none',
    note: '',
  }),
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
  run_mode: z.enum(RUN_MODES).default('manual'),
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
  run_mode: z.enum(RUN_MODES).optional(),
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
  assignee_agent_id: z.string().nullable().optional(),
  assignee_name: z.string().nullable().optional(),
  queue_order: z.number().int().nullable().optional(),
  review: TaskReviewSchema.partial().optional(),
});

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  goal: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  constraints: z.string().optional(),
  agent_notes: z.string().optional(),
  expected_version: z.number().int().positive(),
  use_isolation: z.boolean().optional(),
  assignee_agent_id: z.string().nullable().optional(),
  assignee_name: z.string().nullable().optional(),
  queue_order: z.number().int().nullable().optional(),
  review: TaskReviewSchema.partial().optional(),
});

export const CreateStaffAgentSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  system_prompt: z.string().min(1),
  skills_tags: z.array(z.string()).optional().default([]),
  assignable: z.boolean().optional(),
  creation_rationale: z.string().optional(),
});

export const UpdateStaffAgentSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  system_prompt: z.string().min(1).optional(),
  skills_tags: z.array(z.string()).optional(),
  assignable: z.boolean().optional(),
  status: z.enum(STAFF_STATUSES).optional(),
  creation_rationale: z.string().optional(),
});

export const CreateAutoRunSchema = z.object({
  goal: z.string().min(1),
});

export const AutoRunMessageSchema = z.object({
  message: z.string().min(1),
});

export const ResolveDecisionSchema = z
  .object({
    chosen_option_id: z.string().min(1),
    note: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.chosen_option_id === CUSTOM_DECISION_OPTION_ID && !val.note?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '自訂決策請填寫說明',
        path: ['note'],
      });
    }
  });

export const ReviewPolicySchema = z.object({
  version: z.number().int().positive().default(1),
  ai_review_paths: z.array(z.string()).default([]),
  ai_review_task_types: z.array(z.string()).default([]),
  human_verify_paths: z.array(z.string()).default([]),
  human_verify_notes: z.string().default(''),
  default_reviewer_type: z.enum(REVIEWER_TYPES).default('human'),
  confirmed: z.boolean().default(false),
  confirmed_at: z.string().nullable().optional(),
});
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;

export const UpdateReviewPolicySchema = ReviewPolicySchema.partial();

export const ClaimTaskSchema = z.object({
  agent_name: z.string().min(1),
  expected_version: z.number().int().positive(),
  agent_id: z.string().optional(),
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
  /** AI reviewer 可退回重做 */
  done: ['todo'],
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
  if (task.status !== 'done') return false;
  const review = task.review;
  if (review?.required === false || review?.reviewer_type === 'none') return false;
  if (review?.status === 'approved') return false;
  if (!review || review.reviewer_type === 'human') {
    return !task.human_reviewed;
  }
  return review.status === 'pending' || review.status === 'none';
}

export function needsHumanAttention(task: TaskFrontmatter): boolean {
  if (task.status === 'draft') return true;
  if (task.status === 'done' && (!task.review || task.review.reviewer_type === 'human')) {
    if (isPendingReview(task)) return true;
  }
  if (
    task.status === 'done' &&
    task.review?.reviewer_type === 'human' &&
    (task.review.status === 'pending' || !task.human_reviewed)
  ) {
    return true;
  }
  return false;
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

export const FileContentResponseSchema = z.object({
  path: z.string(),
  status: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
  missing: z.boolean(),
  label: z.string(),
  from: z.enum(['worktree', 'base', 'head', 'branch']),
});

export type FileContentResponse = z.infer<typeof FileContentResponseSchema>;

export const CheckoutBranchSchema = z.object({
  branch: z.string().min(1),
});

export const WorkspaceGitBranchSchema = z.object({
  name: z.string(),
  worktree_path: z.string().nullable(),
  selectable: z.boolean(),
  current: z.boolean(),
});

export const WorkspaceGitStatusSchema = z.object({
  available: z.boolean(),
  git_root: z.string().nullable(),
  current_branch: z.string().nullable(),
  dirty: z.boolean(),
  branches: z.array(WorkspaceGitBranchSchema),
});

export type WorkspaceGitStatus = z.infer<typeof WorkspaceGitStatusSchema>;

export const MergeTaskBranchSchema = z.object({
  target_branch: z.string().min(1),
});

export const TaskGitMergedStatusSchema = z.object({
  branch: z.string(),
  merged: z.boolean(),
});

export const TaskGitStatusSchema = z.object({
  available: z.boolean(),
  branch: z.string().nullable(),
  branch_exists: z.boolean(),
  worktree_path: z.string().nullable(),
  worktree_exists: z.boolean(),
  worktree_dirty: z.boolean(),
  workspace_dirty: z.boolean(),
  default_merge_target: z.string().nullable(),
  merge_targets: z.array(z.string()),
  merged_into: z.array(TaskGitMergedStatusSchema),
  merged_into_record: z.string().nullable(),
  can_merge: z.boolean(),
  can_remove_worktree: z.boolean(),
  can_delete_branch: z.boolean(),
  can_restore_worktree: z.boolean(),
  merge_block_reason: z.string().nullable(),
  remove_worktree_block_reason: z.string().nullable(),
  delete_branch_block_reason: z.string().nullable(),
  restore_worktree_block_reason: z.string().nullable(),
  worktree_current_branch: z.string().nullable(),
  temp_branch: z.string().nullable(),
  on_temp_branch: z.boolean(),
  can_switch_temp_branch: z.boolean(),
  can_restore_task_branch: z.boolean(),
  switch_temp_block_reason: z.string().nullable(),
  restore_task_block_reason: z.string().nullable(),
});

export type TaskGitStatus = z.infer<typeof TaskGitStatusSchema>;

export const MergeTaskBranchResultSchema = z.object({
  ok: z.boolean(),
  task: z.unknown().optional(),
  target_branch: z.string().optional(),
  source_branch: z.string().optional(),
  error: z.string().optional(),
  conflicts: z.array(z.string()).optional(),
});

export type MergeTaskBranchResult = z.infer<typeof MergeTaskBranchResultSchema>;

export const WorkspaceDirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
});

export type WorkspaceDirEntry = z.infer<typeof WorkspaceDirEntrySchema>;

export const WorkspaceDirListResponseSchema = z.object({
  path: z.string(),
  entries: z.array(WorkspaceDirEntrySchema),
});

export type WorkspaceDirListResponse = z.infer<typeof WorkspaceDirListResponseSchema>;

export const WorkspaceFileContentResponseSchema = z.object({
  path: z.string(),
  content: z.string().nullable(),
  encoding: z.literal('utf-8').nullable(),
  size: z.number().int().nonnegative(),
  binary: z.boolean(),
  too_large: z.boolean(),
});

export type WorkspaceFileContentResponse = z.infer<typeof WorkspaceFileContentResponseSchema>;

export const StudioEngineSchema = z.enum(['internal', 'external']);
export type StudioEngine = z.infer<typeof StudioEngineSchema>;

export const RequirementsSourceSchema = z.enum(['prompt', 'codebase']);
export type RequirementsSource = z.infer<typeof RequirementsSourceSchema>;

export const StudioMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  engine: StudioEngineSchema.optional(),
  at: z.string(),
});

export type StudioMessage = z.infer<typeof StudioMessageSchema>;

export const UpdateRequirementsSchema = z.object({
  markdown: z.string(),
});

export const AnalyzeRequirementsSchema = z.object({
  source: RequirementsSourceSchema.default('prompt'),
  message: z.string().default(''),
});

export const CreateDesignSchema = z.object({
  title: z.string().min(1),
});

export const UpdateDesignSchema = z.object({
  title: z.string().min(1).optional(),
  html: z.string().optional(),
});

export const GenerateDesignSchema = z.object({
  message: z.string().min(1),
  design_id: z.string().optional(),
  title: z.string().optional(),
});
