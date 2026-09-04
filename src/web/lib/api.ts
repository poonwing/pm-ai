let cachedToken: string | null = null;

async function fetchToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const res = await fetch('/api/v1/config', {
    headers: { 'X-PM-AI-Actor': 'human' },
  });
  if (res.ok) {
    const data = (await res.json()) as { token: string };
    cachedToken = data.token;
    localStorage.setItem('pm-ai-token', data.token);
    return data.token;
  }
  // Fallback: try to read from localStorage
  const stored = localStorage.getItem('pm-ai-token');
  if (stored) {
    cachedToken = stored;
    return stored;
  }
  throw new Error('無法取得 API token，請確認服務已啟動');
}

export function setToken(token: string) {
  cachedToken = token;
  localStorage.setItem('pm-ai-token', token);
}

export async function api<T>(
  path: string,
  options: RequestInit & { actor?: 'human' | 'agent' } = {},
): Promise<T> {
  const token = await fetchToken();
  const { actor = 'human', ...fetchOptions } = options;

  const res = await fetch(`/api/v1${path}`, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-PM-AI-Actor': actor,
      ...(fetchOptions.headers ?? {}),
    },
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as {
      error: string;
      code?: string;
      conflicts?: string[];
    };
    const message = err.error || `HTTP ${res.status}`;
    const apiErr = new Error(message) as Error & {
      code?: string;
      conflicts?: string[];
    };
    if (err.code) apiErr.code = err.code;
    if (err.conflicts) apiErr.conflicts = err.conflicts;
    throw apiErr;
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  description: string;
  bindingStatus: string;
  archived: boolean;
  gitRoot: string | null;
  createdAt: string;
  lastOpenedAt: string | null;
  previewCommand?: string;
  previewInstallCommand?: string;
  previewInstallIfNeeded?: boolean;
  previewWorkdir?: string;
  runMode?: 'manual' | 'auto';
  runnerProvider?: 'cursor' | 'pi';
}

export interface PreviewInfo {
  status: import('@shared/schemas').PreviewStatus;
  port: number | null;
  url: string | null;
  pid: number | null;
  cwd: string | null;
  command: string | null;
  log_tail: string[];
  error: string | null;
  started_at: string | null;
}

export interface ChangedFile {
  path: string;
  status: import('@shared/schemas').ChangeFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface TaskChangesSummary {
  mode: 'isolated' | 'workspace' | 'none';
  base_sha: string | null;
  head_sha: string | null;
  base_label: string;
  head_label: string;
  has_uncommitted: boolean;
  warning?: string;
  files: ChangedFile[];
  stats: { files: number; additions: number; deletions: number };
}

export interface FileDiffResponse {
  path: string;
  status: string;
  patch: string;
  too_large: boolean;
  old_label: string;
  new_label: string;
  binary: boolean;
}

export interface Task {
  uid: string;
  projectId: string;
  id: string;
  relPath: string;
  title: string;
  status: import('@shared/schemas').TaskStatus;
  version: number;
  humanReviewed: boolean;
  claimedBy: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  body: string;
  workspacePath: string;
  goal?: string;
  acceptance_criteria?: string;
  constraints?: string;
  agent_notes?: string;
  result_note?: string;
  artifacts?: string[];
  rejections?: Array<{ reason: string; at: string; by: string }>;
  activities?: ActivityLog[];
  comments?: TaskComment[];
  lease?: Lease | null;
  git_branch?: string | null;
  worktree_path?: string | null;
  isolation_base_sha?: string | null;
  isolation_status?: import('@shared/schemas').IsolationStatus;
  isolation_error?: string | null;
  execution_path?: string;
  workspace_path?: string;
  use_isolation?: boolean;
  merged_into?: string | null;
  merged_at?: string | null;
  preview?: PreviewInfo;
  assignee_agent_id?: string | null;
  assignee_name?: string | null;
  queue_order?: number | null;
  review?: {
    required: boolean;
    reviewer_type: 'human' | 'agent' | 'orchestrator' | 'none';
    reviewer_agent_id?: string | null;
    status: 'none' | 'pending' | 'approved' | 'rejected';
    note?: string;
  };
}

export interface TaskGitMergedStatus {
  branch: string;
  merged: boolean;
}

export interface TaskGitStatus {
  available: boolean;
  branch: string | null;
  branch_exists: boolean;
  worktree_path: string | null;
  worktree_exists: boolean;
  worktree_dirty: boolean;
  workspace_dirty: boolean;
  default_merge_target: string | null;
  merge_targets: string[];
  merged_into: TaskGitMergedStatus[];
  merged_into_record: string | null;
  can_merge: boolean;
  can_remove_worktree: boolean;
  can_delete_branch: boolean;
  can_restore_worktree: boolean;
  merge_block_reason: string | null;
  remove_worktree_block_reason: string | null;
  delete_branch_block_reason: string | null;
  restore_worktree_block_reason: string | null;
  worktree_current_branch: string | null;
  temp_branch: string | null;
  on_temp_branch: boolean;
  can_switch_temp_branch: boolean;
  can_restore_task_branch: boolean;
  switch_temp_block_reason: string | null;
  restore_task_block_reason: string | null;
}

export interface TaskComment {
  id: string;
  at: string;
  task_id?: string;
  actor: string;
  actor_name?: string | null;
  actorName?: string | null;
  body: string;
}

export interface ActivityLog {
  id: string;
  projectId: string;
  taskId: string;
  at: string;
  actor: string;
  actorName: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  summary: string | null;
  body: string | null;
}

export interface Lease {
  taskUid: string;
  agentName: string;
  leaseToken: string;
  expiresAt: string;
  createdAt: string;
}

export interface Dashboard {
  pendingReview: Task[];
  draftsNeedingPublish: Task[];
  drafts: Task[];
  inProgress: Task[];
  recentActivities: ActivityLog[];
  stats: {
    total: number;
    draft: number;
    todo: number;
    inProgress: number;
    done: number;
    cancelled: number;
    pendingReview: number;
  };
}

export interface AppConfig {
  baseUrl: string;
  port: number;
  token: string;
  lanMode?: boolean;
  lanUrls?: string[];
}

export interface WorkspaceGitBranch {
  name: string;
  worktree_path: string | null;
  selectable: boolean;
  current: boolean;
}

export interface WorkspaceGitStatus {
  available: boolean;
  git_root: string | null;
  current_branch: string | null;
  dirty: boolean;
  branches: WorkspaceGitBranch[];
}

export interface WorkspaceDirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  mtime?: string;
}

export interface WorkspaceDirListResponse {
  path: string;
  entries: WorkspaceDirEntry[];
}

export interface WorkspaceFileContentResponse {
  path: string;
  content: string | null;
  encoding: 'utf-8' | null;
  size: number;
  binary: boolean;
  too_large: boolean;
}

export const projectsApi = {
  list: () => api<Project[]>('/projects'),
  get: (id: string) => api<Project>(`/projects/${id}`),
  create: (data: { name: string; workspace_path: string; description?: string }) =>
    api<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  update: (
    id: string,
    data: {
      name?: string;
      description?: string;
      archived?: boolean;
      preview_command?: string;
      preview_install_command?: string;
      preview_install_if_needed?: boolean;
      preview_workdir?: string;
      run_mode?: 'manual' | 'auto';
      runner_provider?: 'cursor' | 'pi';
    },
  ) =>
    api<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  relocate: (id: string, workspace_path: string) =>
    api<Project>(`/projects/${id}/relocate`, {
      method: 'POST',
      body: JSON.stringify({ workspace_path }),
    }),
  reinstallSkill: (id: string) =>
    api<{ installed: boolean; skillPath: string | null; updated: boolean }>(
      `/projects/${id}/skill/reinstall`,
      { method: 'POST' },
    ),
  initialize: (id: string) =>
    api<{
      project: Project;
      structure_ensured: boolean;
      structure_was_missing: boolean;
      config_created: boolean;
      skill: { installed: boolean; skillPath: string | null; updated: boolean };
      git_root: string | null;
    }>(`/projects/${id}/initialize`, { method: 'POST' }),
  dashboard: (id: string) => api<Dashboard>(`/projects/${id}/dashboard`),
  delete: (id: string, options?: { force?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.force) params.set('force', '1');
    const qs = params.toString();
    return api<{ deleted: boolean; id: string; warnings?: string[] }>(
      `/projects/${id}${qs ? `?${qs}` : ''}`,
      { method: 'DELETE' },
    );
  },
  getGit: (id: string) => api<WorkspaceGitStatus>(`/projects/${id}/git`),
  checkoutBranch: (id: string, branch: string) =>
    api<WorkspaceGitStatus>(`/projects/${id}/git/checkout`, {
      method: 'POST',
      body: JSON.stringify({ branch }),
    }),
  listFiles: (id: string, path = '') => {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    const qs = params.toString();
    return api<WorkspaceDirListResponse>(`/projects/${id}/files${qs ? `?${qs}` : ''}`);
  },
  getFileContent: (id: string, path: string) => {
    const params = new URLSearchParams({ path });
    return api<WorkspaceFileContentResponse>(`/projects/${id}/files/content?${params}`);
  },
};

export const tasksApi = {
  list: (projectId: string, status?: string) =>
    api<Task[]>(`/projects/${projectId}/tasks${status ? `?status=${status}` : ''}`),
  get: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}?project_id=${projectId}`),
  create: (
    projectId: string,
    data: {
      title: string;
      goal?: string;
      acceptance_criteria?: string;
      constraints?: string;
      agent_notes?: string;
      use_isolation?: boolean;
      assignee_agent_id?: string | null;
      assignee_name?: string | null;
      queue_order?: number | null;
      review?: Partial<Task['review']>;
    },
  ) =>
    api<Task>(`/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
  update: (
    projectId: string,
    taskId: string,
    data: {
      title?: string;
      goal?: string;
      acceptance_criteria?: string;
      constraints?: string;
      expected_version: number;
      use_isolation?: boolean;
      assignee_agent_id?: string | null;
      assignee_name?: string | null;
      queue_order?: number | null;
      review?: Partial<NonNullable<Task['review']>>;
    },
  ) =>
    api<Task>(`/tasks/${taskId}?project_id=${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  publish: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/publish?project_id=${projectId}`, { method: 'POST' }),
  cancel: (projectId: string, taskId: string, reason?: string) =>
    api<Task>(`/tasks/${taskId}/cancel?project_id=${projectId}`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  reopen: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/reopen?project_id=${projectId}`, { method: 'POST' }),
  delete: (projectId: string, taskId: string, options?: { force?: boolean }) => {
    const params = new URLSearchParams({ project_id: projectId });
    if (options?.force) params.set('force', '1');
    return api<{ deleted: boolean; id: string; warnings?: string[] }>(
      `/tasks/${taskId}?${params.toString()}`,
      { method: 'DELETE' },
    );
  },
  approve: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/review/approve?project_id=${projectId}`, { method: 'POST' }),
  reject: (projectId: string, taskId: string, reason: string) =>
    api<Task>(`/tasks/${taskId}/review/reject?project_id=${projectId}`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  unlock: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/unlock?project_id=${projectId}`, { method: 'POST' }),
  listComments: (projectId: string, taskId: string) =>
    api<TaskComment[]>(`/tasks/${taskId}/comments?project_id=${projectId}`),
  addComment: (projectId: string, taskId: string, body: string) =>
    api<TaskComment>(`/tasks/${taskId}/comments?project_id=${projectId}`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  retryIsolation: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/isolation/retry?project_id=${projectId}`, { method: 'POST' }),
  removeIsolation: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/isolation/remove?project_id=${projectId}`, { method: 'POST' }),
  getGitStatus: (projectId: string, taskId: string) =>
    api<TaskGitStatus>(`/tasks/${taskId}/git?project_id=${projectId}`),
  mergeBranch: (projectId: string, taskId: string, targetBranch: string) =>
    api<Task>(`/tasks/${taskId}/git/merge?project_id=${projectId}`, {
      method: 'POST',
      body: JSON.stringify({ target_branch: targetBranch }),
    }),
  removeWorktree: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/git/remove-worktree?project_id=${projectId}`, { method: 'POST' }),
  deleteBranch: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/git/delete-branch?project_id=${projectId}`, { method: 'POST' }),
  restoreWorktree: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/git/restore-worktree?project_id=${projectId}`, { method: 'POST' }),
  switchTempBranch: (projectId: string, taskId: string) =>
    api<TaskGitStatus>(`/tasks/${taskId}/git/switch-temp-branch?project_id=${projectId}`, {
      method: 'POST',
    }),
  restoreTaskBranch: (projectId: string, taskId: string) =>
    api<TaskGitStatus>(`/tasks/${taskId}/git/restore-task-branch?project_id=${projectId}`, {
      method: 'POST',
    }),
  openInCursor: (projectId: string, taskId: string) =>
    api<{ opened: string }>(`/tasks/${taskId}/isolation/open-cursor?project_id=${projectId}`, {
      method: 'POST',
    }),
  getPreview: (projectId: string, taskId: string) =>
    api<PreviewInfo>(`/tasks/${taskId}/preview?project_id=${projectId}`),
  startPreview: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/preview/start?project_id=${projectId}`, { method: 'POST' }),
  stopPreview: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}/preview/stop?project_id=${projectId}`, { method: 'POST' }),
  getChanges: (projectId: string, taskId: string) =>
    api<TaskChangesSummary>(`/tasks/${taskId}/changes?project_id=${projectId}`),
  getChangeDiff: (projectId: string, taskId: string, path: string) =>
    api<FileDiffResponse>(
      `/tasks/${taskId}/changes/diff?project_id=${projectId}&path=${encodeURIComponent(path)}`,
    ),
  getRunnerLogs: (projectId: string, taskId: string, sinceSeq = 0) =>
    api<RunnerLogsResponse>(
      `/tasks/${taskId}/runner/logs?project_id=${projectId}&since_seq=${sinceSeq}`,
    ),
  streamRunnerLogs: (
    projectId: string,
    taskId: string,
    handlers: {
      onInit?: (data: RunnerLogsResponse) => void;
      onLog?: (entry: RunnerLogEntry) => void;
      onDone?: (data: { job: RunnerJobInfo | null; latestSeq: number }) => void;
      onError?: (error: Error) => void;
    },
    options?: { sinceSeq?: number; signal?: AbortSignal },
  ) => streamRunnerLogsImpl(projectId, taskId, handlers, options),
};

export interface RunnerLogEntry {
  seq: number;
  at: string;
  kind: 'system' | 'assistant' | 'tool' | 'thinking' | 'error';
  text: string;
}

export interface RunnerJobInfo {
  id: string;
  taskId: string;
  status: string;
  agentName: string;
  provider?: string;
  error?: string | null;
  resultSummary?: string | null;
  updatedAt: string;
}

export interface RunnerLogsResponse {
  entries: RunnerLogEntry[];
  latestSeq: number;
  job: RunnerJobInfo | null;
}

async function streamRunnerLogsImpl(
  projectId: string,
  taskId: string,
  handlers: {
    onInit?: (data: RunnerLogsResponse) => void;
    onLog?: (entry: RunnerLogEntry) => void;
    onDone?: (data: { job: RunnerJobInfo | null; latestSeq: number }) => void;
    onError?: (error: Error) => void;
  },
  options?: { sinceSeq?: number; signal?: AbortSignal },
) {
  const token = await fetchToken();
  const sinceSeq = options?.sinceSeq ?? 0;
  const params = new URLSearchParams({
    project_id: projectId,
    since_seq: String(sinceSeq),
  });

  try {
    const res = await fetch(`/api/v1/tasks/${taskId}/runner/stream?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-PM-AI-Actor': 'human',
        Accept: 'text/event-stream',
      },
      signal: options?.signal,
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('無法讀取 streaming 回應');

    const decoder = new TextDecoder();
    let buffer = '';

    const dispatch = (block: string) => {
      const lines = block.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) return;
      const parsed = JSON.parse(data) as unknown;
      if (event === 'init') handlers.onInit?.(parsed as RunnerLogsResponse);
      else if (event === 'log') handlers.onLog?.(parsed as RunnerLogEntry);
      else if (event === 'done') handlers.onDone?.(parsed as { job: RunnerJobInfo | null; latestSeq: number });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.trim()) dispatch(part);
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } catch (err) {
    if (options?.signal?.aborted) return;
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

export const configApi = {
  get: () => api<AppConfig>('/config'),
  regenerateToken: () =>
    api<{ token: string }>('/config/regenerate-token', { method: 'POST' }),
};

export const activityApi = {
  recent: () => api<{ activity: ActivityLog | null }>('/activity/recent'),
};

export const dialogsApi = {
  pickFolder: (initialPath?: string) =>
    api<{ cancelled: boolean; path: string | null }>('/dialogs/pick-folder', {
      method: 'POST',
      body: JSON.stringify({ initial_path: initialPath }),
    }),
};

export function folderNameFromPath(folderPath: string): string {
  const parts = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

export interface StaffAgent {
  id: string;
  project_id: string;
  name: string;
  role: string;
  system_prompt: string;
  skills_tags: string[];
  status: string;
  assignable: boolean;
  created_by: string;
  prompt_source: string;
  creation_rationale?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutoRun {
  id: string;
  project_id: string;
  goal: string;
  status: string;
  phase: string;
  thread_id: string;
  created_at: string;
  updated_at: string;
}

export interface AutoRunMessage {
  id: string;
  run_id: string;
  role: string;
  content: string;
  at: string;
}

export type AutoBlockedReason =
  | 'none'
  | 'stopped'
  | 'completed'
  | 'paused'
  | 'awaiting_human'
  | 'awaiting_decision'
  | 'wait_runner'
  | 'wait_ai_review'
  | 'ai_review_cooldown'
  | 'no_model'
  | 'wait_events'
  | 'unknown';

export interface AutoRunDebugSnapshot {
  runId: string;
  projectId: string;
  goal: string;
  status: string;
  phase: string;
  threadId: string;
  modelConfigured: boolean;
  blockedReason: AutoBlockedReason;
  blockedHint: string;
  graph: {
    hasGraphState: boolean;
    pendingInterrupt: boolean;
    next: string[];
    tasks: Array<{ id: string; name: string; interruptCount: number }>;
    values: {
      phase: string | null;
      status: string | null;
      pendingCommand: unknown;
      stopRequested: boolean;
      skipClarify: boolean;
      forceReplan: boolean;
      halt: boolean;
      createdTaskIds: string[];
    } | null;
    error?: string;
  };
  taskMatrix: {
    total: number;
    draft: number;
    todo: number;
    in_progress: number;
    done: number;
    cancelled: number;
    pending_ai_review: number;
    pending_human_review: number;
  };
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    reviewerType: string | null;
    reviewStatus: string | null;
    humanReviewed: boolean;
    pendingReview: boolean;
  }>;
  aiReviews: Array<{
    taskId: string;
    title: string;
    reviewerType: string;
    reviewStatus: string;
    inFlight: boolean;
    cooldownRemainingMs: number;
  }>;
  aiReviewActivity: {
    status: 'none' | 'in_flight' | 'cooldown' | 'idle_pending' | 'no_model';
    summary: string;
    inFlightCount: number;
    cooldownCount: number;
    readyCount: number;
    pendingCount: number;
  };
  runner: {
    provider: string;
    source: string;
    configured: boolean;
    ready: boolean;
    activeCount: number;
    jobs: Array<{
      id: string;
      taskId: string;
      status: string;
      provider: string | null;
      agentName: string;
      error: string | null;
      updatedAt: string;
    }>;
  };
  openDecisions: Array<{ id: string; title: string; status: string }>;
  checkpoint: {
    research_done: boolean;
    research_task_id: string | null;
    skip_clarify_after_research: boolean;
    clarified: boolean;
    design: {
      active_stage: string | null;
      design_done: boolean;
      skipped: string[];
    } | null;
    force_redesign: boolean;
    dispatch_waves: number;
    dispatch_enqueued: number;
    feedback_pending: number;
    created_task_ids: string[];
    plan_task_count: number | null;
    runner_retry_counts: Record<string, number>;
    runner_stall_notified: string[];
  };
  events: AutoRunEvent[];
  generatedAt: string;
}

export interface AutoRunEvent {
  id: string;
  run_id: string;
  category: 'graph' | 'runner' | 'ai_review' | 'decision' | 'system' | string;
  type: string;
  summary: string;
  data: Record<string, unknown>;
  task_id: string | null;
  at: string;
}

export interface Decision {
  id: string;
  project_id: string;
  run_id: string | null;
  title: string;
  summary: string;
  options: Array<{ id: string; label: string; description?: string }>;
  recommended_option_id: string | null;
  chosen_option_id: string | null;
  status: string;
  note: string | null;
  created_at: string;
}

export interface ReviewPolicy {
  project_id: string;
  version: number;
  ai_review_paths: string[];
  ai_review_task_types: string[];
  human_verify_paths: string[];
  human_verify_notes: string;
  default_reviewer_type: string;
  confirmed: boolean;
  confirmed_at?: string | null;
}

export const agentsApi = {
  list: (projectId: string) => api<StaffAgent[]>(`/projects/${projectId}/agents`),
  create: (
    projectId: string,
    data: {
      name: string;
      role: string;
      system_prompt: string;
      skills_tags?: string[];
      assignable?: boolean;
      creation_rationale?: string;
    },
  ) =>
    api<StaffAgent>(`/projects/${projectId}/agents`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (
    agentId: string,
    data: Partial<{
      name: string;
      role: string;
      system_prompt: string;
      skills_tags: string[];
      assignable: boolean;
      status: string;
    }>,
  ) => api<StaffAgent>(`/agents/${agentId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  retire: (agentId: string) =>
    api<StaffAgent>(`/agents/${agentId}/retire`, { method: 'POST' }),
  get: (agentId: string) => api<StaffAgent>(`/agents/${agentId}`),
};

export const autoApi = {
  listRuns: (projectId: string) => api<AutoRun[]>(`/projects/${projectId}/runs`),
  startRun: (projectId: string, goal: string) =>
    api<{ run: AutoRun; messages: AutoRunMessage[]; decisions?: Decision[] }>(
      `/projects/${projectId}/runs`,
      { method: 'POST', body: JSON.stringify({ goal }) },
    ),
  getRun: (runId: string) =>
    api<{ run: AutoRun; messages: AutoRunMessage[]; decisions: Decision[] }>(`/runs/${runId}`),
  getRunDebug: (runId: string) => api<AutoRunDebugSnapshot>(`/runs/${runId}/debug`),
  listEvents: (runId: string, opts?: { category?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts?.category) q.set('category', opts.category);
    if (opts?.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return api<{ events: AutoRunEvent[] }>(`/runs/${runId}/events${qs ? `?${qs}` : ''}`);
  },
  message: (runId: string, message: string) =>
    api<{ run: AutoRun; messages: AutoRunMessage[]; decisions?: Decision[] }>(
      `/runs/${runId}/message`,
      { method: 'POST', body: JSON.stringify({ message }) },
    ),
  pause: (runId: string) => api<AutoRun>(`/runs/${runId}/pause`, { method: 'POST' }),
  resume: (runId: string) =>
    api<{ run: AutoRun; messages: AutoRunMessage[] }>(`/runs/${runId}/resume`, {
      method: 'POST',
    }),
  stop: (runId: string) => api<AutoRun>(`/runs/${runId}/stop`, { method: 'POST' }),
  tick: (runId: string) =>
    api<{ run: AutoRun; messages: AutoRunMessage[] }>(`/runs/${runId}/tick`, { method: 'POST' }),
  listDecisions: (projectId: string, status?: string) =>
    api<Decision[]>(
      `/projects/${projectId}/decisions${status ? `?status=${status}` : ''}`,
    ),
  resolveDecision: (decisionId: string, chosen_option_id: string, note?: string) =>
    api<{ decision: Decision; run?: AutoRun; messages?: AutoRunMessage[] }>(
      `/decisions/${decisionId}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({ chosen_option_id, note }),
      },
    ),
  listMeetings: (projectId: string) => api<unknown[]>(`/projects/${projectId}/meetings`),
  getPolicy: (projectId: string) => api<ReviewPolicy>(`/projects/${projectId}/review-policy`),
  updatePolicy: (projectId: string, data: Partial<ReviewPolicy>, confirm?: boolean) =>
    api<ReviewPolicy>(
      `/projects/${projectId}/review-policy${confirm ? '?confirm=1' : ''}`,
      { method: 'PUT', body: JSON.stringify(data) },
    ),
  runnerStatus: (projectId: string) =>
    api<{
      provider: 'cursor' | 'pi';
      defaultProvider?: 'cursor' | 'pi';
      source?: 'project' | 'env';
      configured: boolean;
      cliInstalled: boolean;
      ready: boolean;
      hint: string | null;
      concurrency: number;
      jobs: Array<{
        id: string;
        taskId: string;
        kind?: 'task' | 'studio';
        studioKind?: 'requirements' | 'design';
        status: string;
        agentName: string;
        provider?: string;
        error?: string | null;
        resultSummary?: string | null;
        updatedAt: string;
      }>;
    }>(`/projects/${projectId}/runner/status`),
};

export type ChatMode = 'ask' | 'agent';

export interface ChatSession {
  id: string;
  project_id: string;
  title: string;
  mode: ChatMode;
  status: 'idle' | 'streaming' | 'running' | 'error';
  provider?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  kind: 'text' | 'system' | 'tool' | 'thinking' | 'error';
  at: string;
}

export interface ChatStreamEvent {
  seq: number;
  at: string;
  kind: 'system' | 'assistant' | 'tool' | 'thinking' | 'error' | 'status';
  text: string;
  messageId?: string;
}

export const chatApi = {
  listSessions: (projectId: string) =>
    api<ChatSession[]>(`/projects/${projectId}/chat/sessions`),
  createSession: (projectId: string, data?: { title?: string; mode?: ChatMode }) =>
    api<ChatSession>(`/projects/${projectId}/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),
  getSession: (projectId: string, sessionId: string) =>
    api<ChatSession>(`/projects/${projectId}/chat/sessions/${sessionId}`),
  deleteSession: (projectId: string, sessionId: string) =>
    api<{ deleted: boolean; id: string }>(
      `/projects/${projectId}/chat/sessions/${sessionId}`,
      { method: 'DELETE' },
    ),
  setMode: (projectId: string, sessionId: string, mode: ChatMode) =>
    api<ChatSession>(`/projects/${projectId}/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
    }),
  listMessages: (projectId: string, sessionId: string) =>
    api<ChatMessage[]>(`/projects/${projectId}/chat/sessions/${sessionId}/messages`),
  sendMessage: (
    projectId: string,
    sessionId: string,
    data: { message: string; mode?: ChatMode },
  ) =>
    api<{ session: ChatSession; messages: ChatMessage[] }>(
      `/projects/${projectId}/chat/sessions/${sessionId}/messages`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
  stream: (
    projectId: string,
    sessionId: string,
    handlers: {
      onInit?: (data: {
        entries: ChatStreamEvent[];
        latestSeq: number;
        session: ChatSession;
      }) => void;
      onEvent?: (entry: ChatStreamEvent) => void;
      onDone?: (data: { session: ChatSession; latestSeq: number }) => void;
      onError?: (error: Error) => void;
    },
    options?: { sinceSeq?: number; signal?: AbortSignal },
  ) => streamChatImpl(projectId, sessionId, handlers, options),
};

async function streamChatImpl(
  projectId: string,
  sessionId: string,
  handlers: {
    onInit?: (data: {
      entries: ChatStreamEvent[];
      latestSeq: number;
      session: ChatSession;
    }) => void;
    onEvent?: (entry: ChatStreamEvent) => void;
    onDone?: (data: { session: ChatSession; latestSeq: number }) => void;
    onError?: (error: Error) => void;
  },
  options?: { sinceSeq?: number; signal?: AbortSignal },
) {
  const token = await fetchToken();
  const sinceSeq = options?.sinceSeq ?? 0;
  const params = new URLSearchParams({ since_seq: String(sinceSeq) });

  try {
    const res = await fetch(
      `/api/v1/projects/${projectId}/chat/sessions/${sessionId}/stream?${params}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-PM-AI-Actor': 'human',
          Accept: 'text/event-stream',
        },
        signal: options?.signal,
      },
    );
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as {
        error?: string;
      };
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('無法讀取 streaming 回應');
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (eventName === 'init') {
            handlers.onInit?.(
              parsed as {
                entries: ChatStreamEvent[];
                latestSeq: number;
                session: ChatSession;
              },
            );
          } else if (eventName === 'event') {
            handlers.onEvent?.(parsed as ChatStreamEvent);
          } else if (eventName === 'done') {
            handlers.onDone?.(parsed as { session: ChatSession; latestSeq: number });
          }
        } catch {
          /* ignore bad chunk */
        }
        eventName = 'message';
      }
    }
  } catch (err) {
    if (options?.signal?.aborted) return;
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

export interface StudioMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  engine?: 'internal' | 'external';
  at: string;
}

export interface RequirementsDoc {
  markdown: string;
  updatedAt: string | null;
  exists: boolean;
}

export interface DesignItem {
  id: string;
  title: string;
  slug: string;
  updatedAt: string;
}

export interface DesignRecord extends DesignItem {
  html: string;
}

async function downloadFile(apiPath: string, fallbackName: string) {
  const token = await fetchToken();
  const res = await fetch(`/api/v1${apiPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-PM-AI-Actor': 'human',
    },
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition');
  const match = cd?.match(/filename="([^"]+)"/);
  const name = match?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const requirementsApi = {
  get: (projectId: string) => api<RequirementsDoc>(`/projects/${projectId}/requirements`),
  save: (projectId: string, markdown: string) =>
    api<RequirementsDoc>(`/projects/${projectId}/requirements`, {
      method: 'PUT',
      body: JSON.stringify({ markdown }),
    }),
  messages: (projectId: string) =>
    api<StudioMessage[]>(`/projects/${projectId}/requirements/messages`),
  analyze: (projectId: string, data: { message: string }) =>
    api<{
      markdown: string;
      updatedAt: string | null;
      messages: StudioMessage[];
      mode?: 'codebase' | 'prompt' | 'assist';
    }>(`/projects/${projectId}/requirements/analyze`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  download: (projectId: string) =>
    downloadFile(`/projects/${projectId}/requirements/download`, 'requirements.md'),
};

export const designsApi = {
  list: (projectId: string) => api<DesignItem[]>(`/projects/${projectId}/designs`),
  create: (projectId: string, title: string) =>
    api<DesignRecord>(`/projects/${projectId}/designs`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  get: (projectId: string, designId: string) =>
    api<DesignRecord>(`/projects/${projectId}/designs/${designId}`),
  update: (projectId: string, designId: string, data: { title?: string; html?: string }) =>
    api<DesignRecord>(`/projects/${projectId}/designs/${designId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (projectId: string, designId: string) =>
    api<{ deleted: boolean; id: string }>(`/projects/${projectId}/designs/${designId}`, {
      method: 'DELETE',
    }),
  messages: (projectId: string) => api<StudioMessage[]>(`/projects/${projectId}/designs/messages`),
  generate: (
    projectId: string,
    data: {
      message: string;
      design_id?: string;
      title?: string;
    },
  ) =>
    api<{
      design: DesignRecord;
      designs: DesignItem[];
      messages: StudioMessage[];
    }>(`/projects/${projectId}/designs/generate`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  download: (projectId: string, designId: string) =>
    downloadFile(`/projects/${projectId}/designs/${designId}/download`, 'design.html'),
};


