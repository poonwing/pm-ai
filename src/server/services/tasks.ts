import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { getDb, schema } from '../db/index.js';
import {
  readProjectConfig,
  writeProjectConfig,
  listTaskFiles,
  readTaskFile,
  writeTaskFile,
  appendActivity,
  appendComment,
  readComments,
  withWriteLock,
  validateWorkspacePath,
  findGitRoot,
  ensurePmAiStructure,
  normalizePath,
} from './files.js';
import {
  DEFAULT_PREVIEW_COMMAND,
  DEFAULT_PREVIEW_INSTALL_COMMAND,
  ProjectConfig,
  TaskFrontmatter,
  TaskStatus,
  CreateProjectSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  CreateCommentSchema,
  canTransition,
  LEASE_DURATION_MS,
  isPendingReview,
  IsolationStatus,
} from '../../shared/schemas.js';
import type { z } from 'zod';
import {
  ensureTaskWorktree,
  getExecutionPath,
  openInCursor,
  removeTaskWorktree,
} from './git.js';
import { installPmAiSkill } from './skill-install.js';
import {
  getPreviewStatus,
  startPreview,
  stopPreview,
  attachPreviewToTask,
} from './preview.js';

export class ConflictError extends Error {
  constructor(
    message: string,
    public current?: TaskFrontmatter,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function now(): string {
  return new Date().toISOString();
}

function enrichTaskResponse<T extends TaskFrontmatter & Record<string, unknown>>(
  task: T,
  workspacePath: string,
): T & {
  workspacePath: string;
  workspace_path: string;
  execution_path: string;
  git_branch: string | null;
  worktree_path: string | null;
  isolation_base_sha: string | null;
  isolation_status: IsolationStatus;
  isolation_error: string | null;
  use_isolation: boolean;
} {
  const gitBranch = (task.git_branch as string | null | undefined) ?? null;
  const worktreePath = (task.worktree_path as string | null | undefined) ?? null;
  const isolationStatus = (task.isolation_status as IsolationStatus | undefined) ?? 'none';
  const isolationBaseSha = (task.isolation_base_sha as string | null | undefined) ?? null;
  const isolationError = (task.isolation_error as string | null | undefined) ?? null;
  const useIsolation = (task.use_isolation as boolean | undefined) ?? false;

  return {
    ...task,
    workspacePath,
    workspace_path: workspacePath,
    git_branch: gitBranch,
    worktree_path: worktreePath,
    isolation_base_sha: isolationBaseSha,
    isolation_status: isolationStatus,
    isolation_error: isolationError,
    use_isolation: useIsolation,
    execution_path: getExecutionPath(workspacePath, {
      worktree_path: worktreePath,
      isolation_status: isolationStatus,
      use_isolation: useIsolation,
    }),
  };
}

function applyTaskIsolation(
  projectId: string,
  taskId: string,
  actor: 'human' | 'agent',
  actorName?: string,
) {
  const project = getProject(projectId);
  if (!project.gitRoot) {
    const task = getTask(projectId, taskId);
    return task;
  }

  const task = getTask(projectId, taskId);
  if (!task.use_isolation) {
    return task;
  }

  const isolation = ensureTaskWorktree(project.gitRoot, projectId, taskId, {
    git_branch: task.git_branch,
    worktree_path: task.worktree_path,
    isolation_status: task.isolation_status,
    isolation_base_sha: task.isolation_base_sha,
  });

  const updated = updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      fm.git_branch = isolation.git_branch;
      fm.worktree_path = isolation.worktree_path;
      fm.isolation_base_sha = isolation.isolation_base_sha;
      fm.isolation_status = isolation.isolation_status;
      fm.isolation_error = isolation.isolation_error ?? null;

      logActivity(project.workspacePath, projectId, taskId, actor, 'updated', {
        actorName,
        summary:
          isolation.isolation_status === 'ready'
            ? `已建立隔離 worktree：${isolation.git_branch}`
            : `worktree 建立失敗：${isolation.isolation_error ?? '未知錯誤'}`,
      });

      return { frontmatter: fm, body };
    },
    actor,
    actorName,
  );

  void updated;
  return getTask(projectId, taskId);
}

function formatTaskId(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

function getTaskFilePath(workspacePath: string, taskId: string): string {
  return path.join(workspacePath, '.pm-ai', 'tasks', `${taskId}.md`);
}

function logActivity(
  workspacePath: string,
  projectId: string,
  taskId: string,
  actor: 'human' | 'agent' | 'system',
  action: string,
  opts: {
    actorName?: string;
    fromStatus?: string;
    toStatus?: string;
    summary?: string;
    body?: string;
  } = {},
) {
  const entry = {
    id: uuidv4(),
    at: now(),
    task_id: taskId,
    actor,
    actor_name: opts.actorName ?? null,
    action: action as import('../../shared/schemas.js').ActivityAction,
    from_status: opts.fromStatus ?? null,
    to_status: opts.toStatus ?? null,
    summary: opts.summary ?? null,
    body: opts.body ?? null,
  };
  appendActivity(workspacePath, entry);

  const db = getDb();
  db.insert(schema.activityLogs).values({
    id: entry.id,
    projectId,
    taskId,
    at: entry.at,
    actor,
    actorName: opts.actorName ?? null,
    action,
    fromStatus: opts.fromStatus ?? null,
    toStatus: opts.toStatus ?? null,
    summary: opts.summary ?? null,
    body: opts.body ?? null,
  }).run();
}

function syncTaskToDb(
  projectId: string,
  workspacePath: string,
  frontmatter: TaskFrontmatter,
  relPath: string,
) {
  const db = getDb();
  db.insert(schema.tasks)
    .values({
      uid: frontmatter.uid,
      projectId,
      id: frontmatter.id,
      relPath,
      title: frontmatter.title,
      status: frontmatter.status,
      version: frontmatter.version,
      humanReviewed: frontmatter.human_reviewed,
      claimedBy: frontmatter.claimed_by ?? null,
      claimedAt: frontmatter.claimed_at ?? null,
      contentHash: frontmatter.content_hash ?? null,
      createdAt: frontmatter.created_at,
      updatedAt: frontmatter.updated_at,
      completedAt: frontmatter.completed_at ?? null,
    })
    .onConflictDoUpdate({
      target: schema.tasks.uid,
      set: {
        title: frontmatter.title,
        status: frontmatter.status,
        version: frontmatter.version,
        humanReviewed: frontmatter.human_reviewed,
        claimedBy: frontmatter.claimed_by ?? null,
        claimedAt: frontmatter.claimed_at ?? null,
        contentHash: frontmatter.content_hash ?? null,
        updatedAt: frontmatter.updated_at,
        completedAt: frontmatter.completed_at ?? null,
      },
    })
    .run();
}

export function checkProjectBinding(workspacePath: string): 'ok' | 'missing' {
  const validation = validateWorkspacePath(workspacePath);
  if (!validation.valid) return 'missing';
  const config = readProjectConfig(workspacePath);
  if (!config) return 'missing';
  return 'ok';
}

export function listProjects() {
  const db = getDb();
  const rows = db.select().from(schema.projects).orderBy(desc(schema.projects.lastOpenedAt)).all();
  return rows.map((p) => ({
    ...p,
    bindingStatus: checkProjectBinding(p.workspacePath),
  }));
}

export function getProject(projectId: string) {
  const db = getDb();
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new NotFoundError('專案不存在');
  const bindingStatus = checkProjectBinding(project.workspacePath);
  const detectedGitRoot = findGitRoot(project.workspacePath);
  const gitRoot = detectedGitRoot ? normalizePath(detectedGitRoot) : null;

  const updates: Partial<typeof schema.projects.$inferInsert> = {};
  if (bindingStatus !== project.bindingStatus) updates.bindingStatus = bindingStatus;
  if (gitRoot !== project.gitRoot) updates.gitRoot = gitRoot;

  if (Object.keys(updates).length > 0) {
    db.update(schema.projects)
      .set(updates)
      .where(eq(schema.projects.id, projectId))
      .run();
  }

  return { ...project, ...updates, bindingStatus, gitRoot, ...getProjectPreviewFields(project.workspacePath) };
}

function getProjectPreviewFields(workspacePath: string) {
  const config = readProjectConfig(workspacePath);
  return {
    previewCommand: config?.preview_command ?? 'npm run dev',
    previewInstallCommand: config?.preview_install_command ?? 'npm install',
    previewInstallIfNeeded: config?.preview_install_if_needed ?? true,
    previewWorkdir: config?.preview_workdir ?? '',
  };
}

export function createProject(input: z.infer<typeof CreateProjectSchema>) {
  const validation = validateWorkspacePath(input.workspace_path);
  if (!validation.valid) throw new ValidationError(validation.error!);

  const normalizedPath = normalizePath(input.workspace_path);
  const db = getDb();

  const existing = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.workspacePath, normalizedPath))
    .get();
  if (existing) throw new ValidationError('此資料夾已綁定其他專案');

  ensurePmAiStructure(normalizedPath);
  const skillInstall = installPmAiSkill(normalizedPath);
  const existingConfig = readProjectConfig(normalizedPath);

  let config: ProjectConfig;
  if (existingConfig) {
    const conflict = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, existingConfig.id))
      .get();
    if (conflict && conflict.workspacePath !== normalizedPath) {
      throw new ValidationError('此 workspace 的 project.yml id 與其他專案衝突');
    }
    config = existingConfig;
    config.name = input.name;
    if (input.description) config.description = input.description;
  } else {
    config = {
      id: uuidv4(),
      name: input.name,
      description: input.description ?? '',
      schema_version: 1,
      created_at: now(),
      status: 'active',
      task_id_prefix: 'TASK',
      next_task_seq: 1,
      preview_command: DEFAULT_PREVIEW_COMMAND,
      preview_install_command: DEFAULT_PREVIEW_INSTALL_COMMAND,
      preview_install_if_needed: true,
      preview_workdir: '',
    };
    writeProjectConfig(normalizedPath, config);
  }

  const gitRoot = findGitRoot(normalizedPath);
  const projectRow = {
    id: config.id,
    name: config.name,
    workspacePath: normalizedPath,
    description: config.description,
    bindingStatus: 'ok' as const,
    archived: false,
    gitRoot: gitRoot ? normalizePath(gitRoot) : null,
    createdAt: config.created_at,
    lastOpenedAt: now(),
    pathLastSeenAt: now(),
  };

  db.insert(schema.projects).values(projectRow).run();
  syncProjectTasks(config.id, normalizedPath);
  return { ...projectRow, config, skillInstall };
}

export function updateProject(
  projectId: string,
  updates: {
    name?: string;
    description?: string;
    archived?: boolean;
    preview_command?: string;
    preview_install_command?: string;
    preview_install_if_needed?: boolean;
    preview_workdir?: string;
  },
) {
  const project = getProject(projectId);
  const db = getDb();

  const config = readProjectConfig(project.workspacePath);
  if (config) {
    if (updates.name) config.name = updates.name;
    if (updates.description !== undefined) config.description = updates.description;
    if (updates.preview_command !== undefined) config.preview_command = updates.preview_command;
    if (updates.preview_install_command !== undefined) {
      config.preview_install_command = updates.preview_install_command;
    }
    if (updates.preview_install_if_needed !== undefined) {
      config.preview_install_if_needed = updates.preview_install_if_needed;
    }
    if (updates.preview_workdir !== undefined) {
      config.preview_workdir = updates.preview_workdir;
    }
    if (
      updates.name ||
      updates.description !== undefined ||
      updates.preview_command !== undefined ||
      updates.preview_install_command !== undefined ||
      updates.preview_install_if_needed !== undefined ||
      updates.preview_workdir !== undefined
    ) {
      writeProjectConfig(project.workspacePath, config);
    }
  }

  const set: Partial<typeof schema.projects.$inferInsert> = {};
  if (updates.name) set.name = updates.name;
  if (updates.description !== undefined) set.description = updates.description;
  if (updates.archived !== undefined) set.archived = updates.archived;

  if (Object.keys(set).length > 0) {
    db.update(schema.projects).set(set).where(eq(schema.projects.id, projectId)).run();
  }
  return getProject(projectId);
}

export function relocateProject(projectId: string, newPath: string) {
  const validation = validateWorkspacePath(newPath);
  if (!validation.valid) throw new ValidationError(validation.error!);

  const normalizedPath = normalizePath(newPath);
  const project = getProject(projectId);
  const config = readProjectConfig(normalizedPath);

  if (!config) throw new ValidationError('新路徑沒有 .pm-ai/project.yml');
  if (config.id !== project.id) {
    throw new ValidationError('新路徑的 project.yml id 與此專案不符');
  }

  const db = getDb();
  db.update(schema.projects)
    .set({
      workspacePath: normalizedPath,
      bindingStatus: 'ok',
      pathLastSeenAt: now(),
      gitRoot: findGitRoot(normalizedPath)
        ? normalizePath(findGitRoot(normalizedPath)!)
        : null,
    })
    .where(eq(schema.projects.id, projectId))
    .run();

  syncProjectTasks(projectId, normalizedPath);
  const skillInstall = installPmAiSkill(normalizedPath);
  return { ...getProject(projectId), skillInstall };
}

export function syncProjectTasks(projectId: string, workspacePath: string) {
  const bindingStatus = checkProjectBinding(workspacePath);
  if (bindingStatus !== 'ok') return [];

  const files = listTaskFiles(workspacePath);
  const tasks: Array<TaskFrontmatter & { body: string; filePath: string }> = [];

  for (const filePath of files) {
    try {
      const { frontmatter, body } = readTaskFile(filePath);
      const relPath = path.relative(workspacePath, filePath).replace(/\\/g, '/');
      syncTaskToDb(projectId, workspacePath, frontmatter, relPath);
      tasks.push({ ...frontmatter, body, filePath });
    } catch {
      // skip malformed files
    }
  }
  return tasks;
}

export function listProjectTasks(projectId: string, statusFilter?: TaskStatus) {
  const project = getProject(projectId);
  syncProjectTasks(projectId, project.workspacePath);

  const db = getDb();
  let query = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId))
    .orderBy(desc(schema.tasks.updatedAt));

  const rows = query.all();
  const filtered = statusFilter ? rows.filter((r) => r.status === statusFilter) : rows;

  return filtered.map((row) => {
    const filePath = path.join(project.workspacePath, row.relPath);
    let body = '';
    let extra: Partial<TaskFrontmatter> = {};
    if (fs.existsSync(filePath)) {
      try {
        const parsed = readTaskFile(filePath);
        body = parsed.body;
        extra = parsed.frontmatter;
      } catch {
        // ignore
      }
    }
    return {
      ...row,
      ...extra,
      projectId,
      body,
      workspacePath: project.workspacePath,
      humanReviewed: extra.human_reviewed ?? row.humanReviewed,
      claimedBy: extra.claimed_by ?? row.claimedBy,
    };
  });
}

export function getTask(projectId: string, taskId: string) {
  const project = getProject(projectId);
  const filePath = getTaskFilePath(project.workspacePath, taskId);
  if (!fs.existsSync(filePath)) throw new NotFoundError('任務不存在');

  const { frontmatter, body } = readTaskFile(filePath);
  syncTaskToDb(projectId, project.workspacePath, frontmatter, `.pm-ai/tasks/${taskId}.md`);

  const db = getDb();
  const activities = db
    .select()
    .from(schema.activityLogs)
    .where(
      and(
        eq(schema.activityLogs.projectId, projectId),
        eq(schema.activityLogs.taskId, taskId),
      ),
    )
    .orderBy(desc(schema.activityLogs.at))
    .limit(50)
    .all();

  const lease = db
    .select()
    .from(schema.leases)
    .where(eq(schema.leases.taskUid, frontmatter.uid))
    .get();

  return attachPreviewToTask(
    enrichTaskResponse(
      {
        ...frontmatter,
        body,
        projectId,
        project_id: projectId,
        humanReviewed: frontmatter.human_reviewed,
        claimedBy: frontmatter.claimed_by ?? null,
        claimedAt: frontmatter.claimed_at ?? null,
        createdAt: frontmatter.created_at,
        updatedAt: frontmatter.updated_at,
        completedAt: frontmatter.completed_at ?? null,
        activities: activities.reverse(),
        comments: readComments(project.workspacePath, taskId),
        lease: lease ?? null,
      },
      project.workspacePath,
    ),
  );
}

export function getTaskByUid(taskUid: string) {
  const db = getDb();
  const row = db.select().from(schema.tasks).where(eq(schema.tasks.uid, taskUid)).get();
  if (!row) throw new NotFoundError('任務不存在');
  return getTask(row.projectId, row.id);
}

export function createTask(
  projectId: string,
  input: z.infer<typeof CreateTaskSchema>,
  actor: 'human' | 'agent' = 'human',
) {
  const project = getProject(projectId);
  if (project.bindingStatus !== 'ok') throw new ValidationError('workspace 不可用');

  const actorName = actor === 'agent' ? (input.agent_name ?? 'agent') : undefined;
  const hasAcceptance = (input.acceptance_criteria ?? '').trim().length > 0;
  const status = actor === 'agent' && hasAcceptance ? 'todo' : 'draft';

  const created = withWriteLock(project.workspacePath, () => {
    const config = readProjectConfig(project.workspacePath)!;
    const taskId = formatTaskId(config.task_id_prefix, config.next_task_seq);
    const ts = now();

    const frontmatter: TaskFrontmatter = {
      id: taskId,
      uid: uuidv4(),
      title: input.title,
      status,
      version: 1,
      human_reviewed: false,
      created_at: ts,
      updated_at: ts,
      created_by: actor,
      updated_by: actor,
      updated_by_name: actorName ?? null,
      goal: input.goal ?? '',
      acceptance_criteria: input.acceptance_criteria ?? '',
      constraints: input.constraints ?? '',
      agent_notes: input.agent_notes ?? '',
      result_note: '',
      artifacts: [],
      rejections: [],
      git_branch: null,
      worktree_path: null,
      isolation_base_sha: null,
      isolation_status: 'none',
      isolation_error: null,
      use_isolation: input.use_isolation ?? false,
    };

    const body = input.goal
      ? `## 目標\n\n${input.goal}\n`
      : '';

    const filePath = getTaskFilePath(project.workspacePath, taskId);
    writeTaskFile(filePath, frontmatter, body);

    config.next_task_seq += 1;
    writeProjectConfig(project.workspacePath, config);

    syncTaskToDb(projectId, project.workspacePath, frontmatter, `.pm-ai/tasks/${taskId}.md`);
    logActivity(project.workspacePath, projectId, taskId, actor, 'created', {
      actorName,
      summary: `建立任務：${input.title}`,
      toStatus: status,
    });

    return { ...frontmatter, body, projectId, workspacePath: project.workspacePath };
  });

  if (status === 'todo' && (input.use_isolation ?? false)) {
    return applyTaskIsolation(projectId, created.id, actor, actorName);
  }

  return getTask(projectId, created.id);
}

function updateTaskInternal(
  projectId: string,
  taskId: string,
  updater: (
    frontmatter: TaskFrontmatter,
    body: string,
  ) => { frontmatter: TaskFrontmatter; body: string },
  actor: 'human' | 'agent',
  actorName?: string,
  expectedVersion?: number,
) {
  const project = getProject(projectId);
  if (project.bindingStatus !== 'ok') throw new ValidationError('workspace 不可用');

  return withWriteLock(project.workspacePath, () => {
    const filePath = getTaskFilePath(project.workspacePath, taskId);
    if (!fs.existsSync(filePath)) throw new NotFoundError('任務不存在');

    const { frontmatter, body } = readTaskFile(filePath);

    if (expectedVersion !== undefined && frontmatter.version !== expectedVersion) {
      throw new ConflictError('版本衝突', frontmatter);
    }

    const result = updater(frontmatter, body);
    result.frontmatter.version += 1;
    result.frontmatter.updated_at = now();
    result.frontmatter.updated_by = actor;
    if (actorName) result.frontmatter.updated_by_name = actorName;

    writeTaskFile(filePath, result.frontmatter, result.body);
    syncTaskToDb(
      projectId,
      project.workspacePath,
      result.frontmatter,
      `.pm-ai/tasks/${taskId}.md`,
    );

    return {
      ...result.frontmatter,
      body: result.body,
      projectId,
      workspacePath: project.workspacePath,
    };
  });
}

export function updateTaskContent(
  projectId: string,
  taskId: string,
  input: z.infer<typeof UpdateTaskSchema>,
) {
  const task = getTask(projectId, taskId);
  if (task.status === 'in_progress') {
    throw new ForbiddenError('處理中的任務規格已鎖定，請先打回或取消');
  }
  if (task.status === 'done' && task.human_reviewed) {
    throw new ForbiddenError('已驗收完成的任務不可修改');
  }

  return updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      if (input.title) fm.title = input.title;
      if (input.goal !== undefined) fm.goal = input.goal;
      if (input.acceptance_criteria !== undefined)
        fm.acceptance_criteria = input.acceptance_criteria;
      if (input.constraints !== undefined) fm.constraints = input.constraints;
      if (input.agent_notes !== undefined) fm.agent_notes = input.agent_notes;
      if (input.use_isolation !== undefined) fm.use_isolation = input.use_isolation;
      return { frontmatter: fm, body };
    },
    'human',
    undefined,
    input.expected_version,
  );
}

function transitionTask(
  projectId: string,
  taskId: string,
  toStatus: TaskStatus,
  actor: 'human' | 'agent',
  actorName?: string,
  opts: {
    expectedVersion?: number;
    reason?: string;
    resultNote?: string;
    artifacts?: string[];
    setHumanReviewed?: boolean;
    clearClaim?: boolean;
    setClaim?: { agentName: string };
  } = {},
) {
  const project = getProject(projectId);

  return updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      if (!canTransition(fm.status, toStatus, actor)) {
        throw new ForbiddenError(`不允許從 ${fm.status} 轉換到 ${toStatus}`);
      }

      const fromStatus = fm.status;
      fm.status = toStatus;

      if (toStatus === 'done') {
        fm.completed_at = now();
        fm.human_reviewed = opts.setHumanReviewed ?? false;
        if (opts.resultNote) fm.result_note = opts.resultNote;
        if (opts.artifacts) fm.artifacts = opts.artifacts;
      } else if (fromStatus === 'done') {
        fm.completed_at = null;
        fm.human_reviewed = false;
      }

      if (opts.clearClaim) {
        fm.claimed_by = null;
        fm.claimed_at = null;
        const db = getDb();
        db.delete(schema.leases).where(eq(schema.leases.taskUid, fm.uid)).run();
      }

      if (opts.setClaim) {
        fm.claimed_by = opts.setClaim.agentName;
        fm.claimed_at = now();
      }

      if (opts.reason && toStatus === 'todo' && fromStatus === 'done') {
        fm.rejections = [
          ...fm.rejections,
          { reason: opts.reason, at: now(), by: actor },
        ];
      }

      logActivity(project.workspacePath, projectId, taskId, actor, 'status_changed', {
        actorName,
        fromStatus,
        toStatus,
        summary: `${fromStatus} → ${toStatus}${opts.reason ? `：${opts.reason}` : ''}`,
      });

      return { frontmatter: fm, body };
    },
    actor,
    actorName,
    opts.expectedVersion,
  );
}

export function publishTask(projectId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  if (!task.title.trim()) throw new ValidationError('標題不可為空');
  if (!task.acceptance_criteria.trim()) {
    throw new ValidationError('驗收標準不可為空，請填寫後再交給 Agent');
  }
  transitionTask(projectId, taskId, 'todo', 'human');
  if (task.use_isolation) {
    return applyTaskIsolation(projectId, taskId, 'human');
  }
  return getTask(projectId, taskId);
}

export function cancelTask(projectId: string, taskId: string, reason?: string) {
  return transitionTask(projectId, taskId, 'cancelled', 'human', undefined, { reason });
}

export function reopenTask(projectId: string, taskId: string) {
  return transitionTask(projectId, taskId, 'todo', 'human', undefined, { clearClaim: true });
}

export function approveReview(projectId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  if (!isPendingReview(task)) throw new ValidationError('此任務不在待驗收狀態');

  return updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      fm.human_reviewed = true;
      logActivity(
        getProject(projectId).workspacePath,
        projectId,
        taskId,
        'human',
        'reviewed',
        { summary: '驗收通過' },
      );
      return { frontmatter: fm, body };
    },
    'human',
  );
}

export function rejectReview(projectId: string, taskId: string, reason: string) {
  const task = getTask(projectId, taskId);
  if (!isPendingReview(task)) throw new ValidationError('此任務不在待驗收狀態');

  return transitionTask(projectId, taskId, 'todo', 'human', undefined, {
    reason,
    clearClaim: true,
  });
}

export function getInbox() {
  const db = getDb();
  const todoTasks = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.status, 'todo'))
    .orderBy(schema.tasks.createdAt)
    .all();

  return todoTasks.map((row) => getTask(row.projectId, row.id));
}

export function claimTask(
  projectId: string,
  taskId: string,
  agentName: string,
  expectedVersion: number,
) {
  const db = getDb();
  const task = getTask(projectId, taskId);

  if (task.status !== 'todo') {
    throw new ForbiddenError('只能認領待處理任務');
  }

  const existingLease = db
    .select()
    .from(schema.leases)
    .where(eq(schema.leases.taskUid, task.uid))
    .get();

  if (existingLease && new Date(existingLease.expiresAt) > new Date()) {
    throw new ConflictError(`任務已被 ${existingLease.agentName} 認領`);
  }

  const leaseToken = uuidv4();
  const expiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();

  const result = transitionTask(projectId, taskId, 'in_progress', 'agent', agentName, {
    expectedVersion,
    setClaim: { agentName },
  });

  db.insert(schema.leases)
    .values({
      taskUid: task.uid,
      agentName,
      leaseToken,
      expiresAt,
      createdAt: now(),
    })
    .onConflictDoUpdate({
      target: schema.leases.taskUid,
      set: { agentName, leaseToken, expiresAt, createdAt: now() },
    })
    .run();

  logActivity(
    getProject(projectId).workspacePath,
    projectId,
    taskId,
    'agent',
    'claimed',
    { actorName: agentName, summary: `${agentName} 認領任務` },
  );

  return { ...result, lease_token: leaseToken, expires_at: expiresAt };
}

function validateLease(taskUid: string, agentName: string, leaseToken: string) {
  const db = getDb();
  const lease = db.select().from(schema.leases).where(eq(schema.leases.taskUid, taskUid)).get();
  if (!lease) throw new ForbiddenError('沒有有效的租約');
  if (lease.agentName !== agentName) throw new ForbiddenError('租約不屬於此 Agent');
  if (lease.leaseToken !== leaseToken) throw new ForbiddenError('租約 token 不符');
  if (new Date(lease.expiresAt) <= new Date()) throw new ForbiddenError('租約已過期');
  return lease;
}

export function heartbeatTask(
  projectId: string,
  taskId: string,
  agentName: string,
  leaseToken: string,
) {
  const task = getTask(projectId, taskId);
  validateLease(task.uid, agentName, leaseToken);

  const expiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  const db = getDb();
  db.update(schema.leases)
    .set({ expiresAt })
    .where(eq(schema.leases.taskUid, task.uid))
    .run();

  return { expires_at: expiresAt };
}

export function progressTask(
  projectId: string,
  taskId: string,
  agentName: string,
  leaseToken: string,
  summary: string,
) {
  const task = getTask(projectId, taskId);
  validateLease(task.uid, agentName, leaseToken);

  logActivity(
    getProject(projectId).workspacePath,
    projectId,
    taskId,
    'agent',
    'progress',
    { actorName: agentName, summary },
  );

  return getTask(projectId, taskId);
}

export function completeTask(
  projectId: string,
  taskId: string,
  agentName: string,
  leaseToken: string,
  resultNote: string,
  artifacts: string[],
) {
  const task = getTask(projectId, taskId);
  validateLease(task.uid, agentName, leaseToken);

  logActivity(
    getProject(projectId).workspacePath,
    projectId,
    taskId,
    'agent',
    'completed',
    { actorName: agentName, summary: resultNote },
  );

  return transitionTask(projectId, taskId, 'done', 'agent', agentName, {
    expectedVersion: task.version,
    resultNote,
    artifacts,
    clearClaim: true,
    setHumanReviewed: false,
  });
}

export function releaseTask(
  projectId: string,
  taskId: string,
  agentName: string,
  leaseToken: string,
  reason?: string,
) {
  const task = getTask(projectId, taskId);
  validateLease(task.uid, agentName, leaseToken);

  logActivity(
    getProject(projectId).workspacePath,
    projectId,
    taskId,
    'agent',
    'unclaimed',
    { actorName: agentName, summary: reason ?? '釋放任務' },
  );

  return transitionTask(projectId, taskId, 'todo', 'agent', agentName, {
    expectedVersion: task.version,
    clearClaim: true,
  });
}

export function forceUnlockTask(projectId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  const db = getDb();
  db.delete(schema.leases).where(eq(schema.leases.taskUid, task.uid)).run();

  return updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      fm.claimed_by = null;
      fm.claimed_at = null;
      logActivity(
        getProject(projectId).workspacePath,
        projectId,
        taskId,
        'human',
        'unclaimed',
        { summary: '人為強制解鎖' },
      );
      return { frontmatter: fm, body };
    },
    'human',
  );
}

export function getDashboard(projectId: string) {
  const tasks = listProjectTasks(projectId);
  const pendingReview = tasks.filter(
    (t) => t.status === 'done' && !t.humanReviewed,
  );
  const drafts = tasks.filter((t) => t.status === 'draft');
  const inProgress = tasks.filter((t) => t.status === 'in_progress');
  const recentActivities = getDb()
    .select()
    .from(schema.activityLogs)
    .where(eq(schema.activityLogs.projectId, projectId))
    .orderBy(desc(schema.activityLogs.at))
    .limit(10)
    .all()
    .reverse();

  return {
    pendingReview,
    draftsNeedingPublish: drafts.filter((t) => !t.title || !t.acceptance_criteria),
    drafts,
    inProgress,
    recentActivities,
    stats: {
      total: tasks.length,
      draft: drafts.length,
      todo: tasks.filter((t) => t.status === 'todo').length,
      inProgress: inProgress.length,
      done: tasks.filter((t) => t.status === 'done').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      pendingReview: pendingReview.length,
    },
  };
}

export function listComments(projectId: string, taskId: string) {
  getTask(projectId, taskId);
  const project = getProject(projectId);
  return readComments(project.workspacePath, taskId);
}

export function addComment(
  projectId: string,
  taskId: string,
  input: z.infer<typeof CreateCommentSchema>,
  actor: 'human' | 'agent',
) {
  getTask(projectId, taskId);
  const project = getProject(projectId);
  const body = input.body.trim();
  if (!body) throw new ValidationError('評論內容不可為空');

  const actorName = actor === 'agent' ? (input.agent_name ?? 'agent') : null;
  const entry = {
    id: uuidv4(),
    at: now(),
    task_id: taskId,
    actor,
    actor_name: actorName,
    body,
  };

  return withWriteLock(project.workspacePath, () => {
    appendComment(project.workspacePath, entry);
    const db = getDb();
    db.insert(schema.comments)
      .values({
        id: entry.id,
        projectId,
        taskId,
        at: entry.at,
        actor,
        actorName,
        body,
      })
      .run();
    logActivity(project.workspacePath, projectId, taskId, actor, 'commented', {
      actorName: actorName ?? undefined,
      summary: body.length > 80 ? `${body.slice(0, 80)}…` : body,
      body,
    });
    return entry;
  });
}

export function reinstallProjectSkill(projectId: string) {
  const project = getProject(projectId);
  if (project.bindingStatus !== 'ok') {
    throw new ValidationError('workspace 不可用');
  }
  const skillInstall = installPmAiSkill(project.workspacePath);
  if (!skillInstall.installed) {
    throw new ValidationError(skillInstall.error ?? 'Skill 安裝失敗');
  }
  return skillInstall;
}

export function retryTaskIsolation(projectId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  if (!task.use_isolation) {
    throw new ValidationError('此任務未啟用 worktree 隔離');
  }
  if (task.status !== 'todo' && task.status !== 'in_progress') {
    throw new ValidationError('只有待處理或處理中的任務可重試建立 worktree');
  }
  return applyTaskIsolation(projectId, taskId, 'human');
}

export function getTaskPreview(projectId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  return task.preview;
}

export async function startTaskPreview(projectId: string, taskId: string) {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);
  try {
    await startPreview(projectId, task.uid, taskId, project.workspacePath, {
      worktree_path: task.worktree_path,
      isolation_status: task.isolation_status,
      use_isolation: task.use_isolation,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(message);
  }
  return getTask(projectId, taskId);
}

export async function stopTaskPreview(projectId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  await stopPreview(task.uid);
  return getTask(projectId, taskId);
}

export function getRecentApiActivity() {
  const db = getDb();
  return db
    .select()
    .from(schema.activityLogs)
    .orderBy(desc(schema.activityLogs.at))
    .limit(1)
    .get();
}

export function removeTaskIsolation(projectId: string, taskId: string) {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);

  if (!project.gitRoot || !task.worktree_path) {
    throw new ValidationError('此任務沒有可清理的 worktree');
  }

  void stopPreview(task.uid).catch(() => undefined);

  const removal = removeTaskWorktree(project.gitRoot, task.worktree_path);
  if (!removal.ok) {
    throw new ValidationError(removal.error ?? '無法移除 worktree');
  }

  updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      fm.isolation_status = 'removed';
      fm.isolation_error = null;
      logActivity(project.workspacePath, projectId, taskId, 'human', 'updated', {
        summary: '已清理隔離 worktree 目錄',
      });
      return { frontmatter: fm, body };
    },
    'human',
  );

  return getTask(projectId, taskId);
}

export async function openTaskInCursor(projectId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  const target = task.execution_path;
  if (!target) throw new ValidationError('沒有可開啟的路徑');

  try {
    await openInCursor(target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      `無法啟動 Cursor：${message}。請確認 cursor 命令已在 PATH 中，或手動開啟：${target}`,
    );
  }

  return { opened: target };
}
