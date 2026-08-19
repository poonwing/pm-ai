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
    };
    throw new Error(err.error || `HTTP ${res.status}`);
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
}

export const projectsApi = {
  list: () => api<Project[]>('/projects'),
  get: (id: string) => api<Project>(`/projects/${id}`),
  create: (data: { name: string; workspace_path: string; description?: string }) =>
    api<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { name?: string; description?: string; archived?: boolean }) =>
    api<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  relocate: (id: string, workspace_path: string) =>
    api<Project>(`/projects/${id}/relocate`, {
      method: 'POST',
      body: JSON.stringify({ workspace_path }),
    }),
  dashboard: (id: string) => api<Dashboard>(`/projects/${id}/dashboard`),
};

export const tasksApi = {
  list: (projectId: string, status?: string) =>
    api<Task[]>(`/projects/${projectId}/tasks${status ? `?status=${status}` : ''}`),
  get: (projectId: string, taskId: string) =>
    api<Task>(`/tasks/${taskId}?project_id=${projectId}`),
  create: (projectId: string, data: { title: string; goal?: string; acceptance_criteria?: string }) =>
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
};

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
