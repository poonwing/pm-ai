import { eq, and, desc, inArray } from 'drizzle-orm';
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
  getCommentsFilePath,
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
  type TaskGitStatus,
} from '../../shared/schemas.js';
import type { z } from 'zod';
import {
  ensureTaskWorktree,
  getExecutionPath,
  openInCursor,
  removeTaskWorktree,
  worktreePathForTask,
  localBranchExists,
  taskBranchName,
  forceDeleteLocalBranch,
  isBranchMergedInto,
  getWorktreeDirty,
  worktreePathExists,
  mergeBranch,
  deleteLocalBranch,
  resolveDefaultMergeTarget,
  collectMergeCheckTargets,
  listLocalBranches,
  hasUncommittedChanges,
  runGit,
  taskTempBranchName,
  getCurrentBranchAt,
  createBranchAt,
  switchBranchAt,
  getHeadSha,
  getCurrentBranch,
} from './git.js';
import { getPmAiDir } from '../paths.js';
import { installPmAiSkill } from './skill-install.js';
import {
  getPreviewStatus,
  startPreview,
  stopPreview,
  stopPreviewsForProject,
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

export class MergeConflictError extends ValidationError {
  constructor(
    message: string,
    public conflicts: string[],
  ) {
    super(message);
    this.name = 'MergeConflictError';
  }
}

export class AlreadyMergedError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyMergedError';
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
    runMode: config?.run_mode ?? 'manual',
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
      run_mode: 'manual',
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
    run_mode?: 'manual' | 'auto';
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
    if (updates.run_mode !== undefined) {
      config.run_mode = updates.run_mode;
    }
    if (
      updates.name ||
      updates.description !== undefined ||
      updates.preview_command !== undefined ||
      updates.preview_install_command !== undefined ||
      updates.preview_install_if_needed !== undefined ||
      updates.preview_workdir !== undefined ||
      updates.run_mode !== undefined
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
      merged_into: null,
      merged_at: null,
      assignee_agent_id: input.assignee_agent_id ?? null,
      assignee_name: input.assignee_name ?? null,
      queue_order: input.queue_order ?? null,
      review: {
        required: input.review?.required ?? true,
        reviewer_type: input.review?.reviewer_type ?? 'human',
        reviewer_agent_id: input.review?.reviewer_agent_id ?? null,
        status: input.review?.status ?? 'none',
        note: input.review?.note ?? '',
      },
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
      if (input.assignee_agent_id !== undefined) fm.assignee_agent_id = input.assignee_agent_id;
      if (input.assignee_name !== undefined) fm.assignee_name = input.assignee_name;
      if (input.queue_order !== undefined) fm.queue_order = input.queue_order;
      if (input.review !== undefined) {
        fm.review = {
          required: input.review.required ?? fm.review?.required ?? true,
          reviewer_type: input.review.reviewer_type ?? fm.review?.reviewer_type ?? 'human',
          reviewer_agent_id:
            input.review.reviewer_agent_id !== undefined
              ? input.review.reviewer_agent_id
              : (fm.review?.reviewer_agent_id ?? null),
          status: input.review.status ?? fm.review?.status ?? 'none',
          note: input.review.note ?? fm.review?.note ?? '',
        };
      }
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
        const review = fm.review ?? {
          required: true,
          reviewer_type: 'human' as const,
          reviewer_agent_id: null,
          status: 'none' as const,
          note: '',
        };
        if (!review.required || review.reviewer_type === 'none') {
          fm.review = { ...review, status: 'approved', required: false, reviewer_type: review.reviewer_type === 'none' ? 'none' : review.reviewer_type };
          if (review.reviewer_type === 'none') fm.human_reviewed = true;
        } else {
          fm.review = { ...review, status: 'pending' };
        }
      } else if (fromStatus === 'done') {
        fm.completed_at = null;
        fm.human_reviewed = false;
        if (fm.review) fm.review = { ...fm.review, status: 'none', note: '' };
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
  assertTaskWorktreeNotOnTempBranch(projectId, taskId);

  return updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      fm.human_reviewed = true;
      fm.review = {
        ...(fm.review ?? {
          required: true,
          reviewer_type: 'human',
          reviewer_agent_id: null,
          status: 'none',
          note: '',
        }),
        status: 'approved',
      };
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
  assertTaskWorktreeNotOnTempBranch(projectId, taskId);

  return transitionTask(projectId, taskId, 'todo', 'human', undefined, {
    reason,
    clearClaim: true,
  });
}

export function getInbox(filters?: {
  assignee_agent_id?: string;
  agent_name?: string;
  project_id?: string;
}) {
  const db = getDb();
  const todoTasks = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.status, 'todo'))
    .orderBy(schema.tasks.createdAt)
    .all();

  let tasks = todoTasks.map((row) => getTask(row.projectId, row.id));
  if (filters?.project_id) {
    tasks = tasks.filter(
      (t) => t.projectId === filters.project_id || t.project_id === filters.project_id,
    );
  }
  if (filters?.assignee_agent_id) {
    tasks = tasks.filter((t) => t.assignee_agent_id === filters.assignee_agent_id);
  } else if (filters?.agent_name) {
    tasks = tasks.filter(
      (t) =>
        !t.assignee_name ||
        t.assignee_name === filters.agent_name ||
        t.assignee_agent_id === filters.agent_name,
    );
  }
  tasks.sort((a, b) => {
    const ao = a.queue_order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.queue_order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return String(a.createdAt ?? a.created_at ?? '').localeCompare(
      String(b.createdAt ?? b.created_at ?? ''),
    );
  });
  return tasks;
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

  const result = transitionTask(projectId, taskId, 'done', 'agent', agentName, {
    expectedVersion: task.version,
    resultNote,
    artifacts,
    clearClaim: true,
    setHumanReviewed: false,
  });

  void import('../orchestrator/index.js')
    .then((m) => m.onTaskEvent(projectId, taskId, 'completed'))
    .catch(() => undefined);

  return result;
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

  const isFailed = task.isolation_status === 'failed';
  if (!isFailed && !task.humanReviewed) {
    throw new ValidationError('請先驗收通過後再刪除 worktree');
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
      fm.worktree_path = null;
      logActivity(project.workspacePath, projectId, taskId, 'human', 'updated', {
        summary: '已刪除隔離 worktree',
      });
      return { frontmatter: fm, body };
    },
    'human',
  );

  return getTask(projectId, taskId);
}

function worktreeStillActive(
  gitRoot: string,
  task: ReturnType<typeof getTask>,
): boolean {
  if (!task.worktree_path) return false;
  if (task.isolation_status === 'removed') return false;
  return worktreePathExists(gitRoot, task.worktree_path);
}

function assertTaskWorktreeNotOnTempBranch(projectId: string, taskId: string): void {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);
  if (!project.gitRoot || !task.worktree_path) return;
  if (!worktreeStillActive(project.gitRoot, task)) return;

  const tempBranch = taskTempBranchName(taskId);
  const current = getCurrentBranchAt(task.worktree_path);
  if (current === tempBranch) {
    throw new ValidationError(
      `worktree 目前在臨時分支 ${tempBranch}。請先在任務詳情點「恢復任務分支」後再操作。`,
    );
  }
}

export function getTaskGitStatus(projectId: string, taskId: string): TaskGitStatus {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);
  const branch = task.git_branch ?? null;
  const worktreePath = task.worktree_path ?? null;
  const mergedIntoRecord = (task.merged_into as string | null | undefined) ?? null;

  if (!project.gitRoot) {
    return {
      available: false,
      branch,
      branch_exists: false,
      worktree_path: worktreePath,
      worktree_exists: false,
      worktree_dirty: false,
      workspace_dirty: false,
      default_merge_target: null,
      merge_targets: [],
      merged_into: [],
      merged_into_record: mergedIntoRecord,
      can_merge: false,
      can_remove_worktree: false,
      can_delete_branch: false,
      can_restore_worktree: false,
      merge_block_reason: '此專案未偵測到 git 倉庫',
      remove_worktree_block_reason: '此專案未偵測到 git 倉庫',
      delete_branch_block_reason: '此專案未偵測到 git 倉庫',
      restore_worktree_block_reason: '此專案未偵測到 git 倉庫',
      worktree_current_branch: null,
      temp_branch: null,
      on_temp_branch: false,
      can_switch_temp_branch: false,
      can_restore_task_branch: false,
      switch_temp_block_reason: '此專案未偵測到 git 倉庫',
      restore_task_block_reason: '此專案未偵測到 git 倉庫',
    };
  }

  const gitRoot = project.gitRoot;
  const branchExists = branch ? localBranchExists(gitRoot, branch) : false;
  const worktreeExists = worktreeStillActive(gitRoot, task);
  const worktreeDirty = worktreePath ? getWorktreeDirty(worktreePath) : false;
  const workspaceDirty = hasUncommittedChanges(gitRoot);
  const defaultTarget = resolveDefaultMergeTarget(gitRoot);
  const mergeTargets = listLocalBranches(gitRoot)
    .filter((b) => b.name !== branch && !b.worktreePath)
    .map((b) => b.name);

  const checkTargets = branch
    ? collectMergeCheckTargets(gitRoot, mergedIntoRecord ?? defaultTarget)
    : [];
  const mergedInto = checkTargets.map((target) => ({
    branch: target,
    merged: branch ? isBranchMergedInto(gitRoot, branch, target) : false,
  }));

  let canMerge = false;
  let mergeBlockReason: string | null = null;
  if (task.status !== 'done') {
    mergeBlockReason = '僅完成狀態的任務可 merge';
  } else if (!branch) {
    mergeBlockReason = '此任務沒有關聯分支';
  } else if (!branchExists) {
    mergeBlockReason = '任務分支已不存在';
  } else if (workspaceDirty) {
    mergeBlockReason = '主 workspace 有未提交變更';
  } else if (mergeTargets.length === 0) {
    mergeBlockReason = '沒有可 merge 的目標分支';
  } else {
    canMerge = true;
  }

  let canRemoveWorktree = false;
  let removeWorktreeBlockReason: string | null = null;
  if (!task.humanReviewed) {
    removeWorktreeBlockReason = '請先驗收通過';
  } else if (!worktreePath) {
    removeWorktreeBlockReason = '沒有 worktree 可刪除';
  } else if (!worktreeExists && task.isolation_status === 'removed') {
    removeWorktreeBlockReason = 'worktree 已刪除';
  } else if (!worktreeExists) {
    removeWorktreeBlockReason = 'worktree 目錄不存在';
  } else {
    canRemoveWorktree = true;
  }

  let canDeleteBranch = false;
  let deleteBranchBlockReason: string | null = null;
  if (!task.humanReviewed) {
    deleteBranchBlockReason = '請先驗收通過';
  } else if (!branch) {
    deleteBranchBlockReason = '沒有分支可刪除';
  } else if (!branchExists) {
    deleteBranchBlockReason = '分支已不存在';
  } else if (worktreeExists) {
    deleteBranchBlockReason = '請先刪除 worktree';
  } else if (mergedInto.every((m) => !m.merged)) {
    const targets = checkTargets.join('、') || 'main/master';
    deleteBranchBlockReason = `分支尚未合入 ${targets}`;
  } else {
    canDeleteBranch = true;
  }

  let canRestoreWorktree = false;
  let restoreWorktreeBlockReason: string | null = null;
  if (!branch) {
    restoreWorktreeBlockReason = '此任務沒有關聯分支';
  } else if (!branchExists) {
    restoreWorktreeBlockReason = '任務分支已不存在，無法恢復';
  } else if (worktreeExists) {
    restoreWorktreeBlockReason = 'worktree 仍在使用中';
  } else {
    const branchInfo = listLocalBranches(gitRoot).find((b) => b.name === branch);
    if (branchInfo?.worktreePath) {
      restoreWorktreeBlockReason = `分支已在其他 worktree 中：${branchInfo.worktreePath}`;
    } else if (branchInfo?.checkedOutHere) {
      restoreWorktreeBlockReason = '分支目前在主 workspace checkout，請先切換分支';
    } else {
      canRestoreWorktree = true;
    }
  }

  const tempBranch = taskTempBranchName(taskId);
  const worktreeCurrentBranch =
    worktreeExists && worktreePath ? getCurrentBranchAt(worktreePath) : null;
  const onTempBranch = worktreeCurrentBranch === tempBranch;
  const workspaceCurrentBranch = getCurrentBranch(gitRoot);

  let canSwitchTempBranch = false;
  let switchTempBlockReason: string | null = null;
  if (!worktreeExists || !worktreePath) {
    switchTempBlockReason = 'worktree 不存在或未就緒';
  } else if (task.isolation_status !== 'ready') {
    switchTempBlockReason = 'worktree 未就緒';
  } else if (!branch || !branchExists) {
    switchTempBlockReason = '任務分支不存在';
  } else if (onTempBranch) {
    switchTempBlockReason = '已在臨時分支上';
  } else if (worktreeCurrentBranch !== branch) {
    switchTempBlockReason = `worktree 目前在 ${worktreeCurrentBranch ?? '未知分支'}，請先切回任務分支`;
  } else {
    canSwitchTempBranch = true;
  }

  let canRestoreTaskBranch = false;
  let restoreTaskBlockReason: string | null = null;
  if (!worktreeExists || !worktreePath) {
    restoreTaskBlockReason = 'worktree 不存在或未就緒';
  } else if (!onTempBranch) {
    restoreTaskBlockReason = 'worktree 不在臨時分支上';
  } else if (!branch || !branchExists) {
    restoreTaskBlockReason = '任務分支不存在';
  } else if (workspaceCurrentBranch === branch) {
    restoreTaskBlockReason = '請先在專案總覽將主 workspace 切離任務分支';
  } else {
    const branchInfo = listLocalBranches(gitRoot).find((b) => b.name === branch);
    if (branchInfo?.worktreePath && path.resolve(branchInfo.worktreePath) !== path.resolve(worktreePath)) {
      restoreTaskBlockReason = `任務分支已在其他 worktree 中：${branchInfo.worktreePath}`;
    } else {
      canRestoreTaskBranch = true;
    }
  }

  return {
    available: true,
    branch,
    branch_exists: branchExists,
    worktree_path: worktreePath,
    worktree_exists: worktreeExists,
    worktree_dirty: worktreeDirty,
    workspace_dirty: workspaceDirty,
    default_merge_target: defaultTarget,
    merge_targets: mergeTargets,
    merged_into: mergedInto,
    merged_into_record: mergedIntoRecord,
    can_merge: canMerge,
    can_remove_worktree: canRemoveWorktree,
    can_delete_branch: canDeleteBranch,
    can_restore_worktree: canRestoreWorktree,
    merge_block_reason: mergeBlockReason,
    remove_worktree_block_reason: removeWorktreeBlockReason,
    delete_branch_block_reason: deleteBranchBlockReason,
    restore_worktree_block_reason: restoreWorktreeBlockReason,
    worktree_current_branch: worktreeCurrentBranch,
    temp_branch: tempBranch,
    on_temp_branch: onTempBranch,
    can_switch_temp_branch: canSwitchTempBranch,
    can_restore_task_branch: canRestoreTaskBranch,
    switch_temp_block_reason: switchTempBlockReason,
    restore_task_block_reason: restoreTaskBlockReason,
  };
}

export function switchTaskWorktreeToTempBranch(projectId: string, taskId: string): TaskGitStatus {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);

  if (!project.gitRoot) {
    throw new ValidationError('此專案未偵測到 git 倉庫');
  }

  const status = getTaskGitStatus(projectId, taskId);
  if (status.on_temp_branch) {
    return status;
  }
  if (!status.can_switch_temp_branch) {
    throw new ValidationError(status.switch_temp_block_reason ?? '無法切換臨時分支');
  }

  const worktreePath = task.worktree_path!;
  const tempBranch = taskTempBranchName(taskId);
  const gitRoot = project.gitRoot;

  if (!localBranchExists(gitRoot, tempBranch)) {
    const head = getHeadSha(worktreePath);
    if (!head) {
      throw new ValidationError('無法讀取 worktree HEAD');
    }
    const created = createBranchAt(gitRoot, tempBranch, head);
    if (!created.ok) {
      throw new ValidationError(created.error);
    }
  }

  const switched = switchBranchAt(worktreePath, tempBranch);
  if (!switched.ok) {
    throw new ValidationError(switched.error);
  }

  return getTaskGitStatus(projectId, taskId);
}

export function restoreTaskWorktreeFromTempBranch(projectId: string, taskId: string): TaskGitStatus {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);

  if (!project.gitRoot) {
    throw new ValidationError('此專案未偵測到 git 倉庫');
  }

  const status = getTaskGitStatus(projectId, taskId);
  if (!status.can_restore_task_branch) {
    throw new ValidationError(status.restore_task_block_reason ?? '無法恢復任務分支');
  }

  const worktreePath = task.worktree_path!;
  const taskBranch = task.git_branch ?? taskBranchName(taskId);
  const tempBranch = taskTempBranchName(taskId);
  const gitRoot = project.gitRoot;

  const switched = switchBranchAt(worktreePath, taskBranch);
  if (!switched.ok) {
    throw new ValidationError(switched.error);
  }

  if (localBranchExists(gitRoot, tempBranch)) {
    const deletion = forceDeleteLocalBranch(gitRoot, tempBranch);
    if (!deletion.ok) {
      throw new ValidationError(deletion.error);
    }
  }

  return getTaskGitStatus(projectId, taskId);
}

export function mergeTaskBranch(
  projectId: string,
  taskId: string,
  targetBranch: string,
) {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);

  if (!project.gitRoot) {
    throw new ValidationError('此專案未偵測到 git 倉庫');
  }
  if (task.status !== 'done') {
    throw new ValidationError('僅完成狀態的任務可 merge');
  }
  if (!task.git_branch) {
    throw new ValidationError('此任務沒有關聯分支');
  }
  if (!localBranchExists(project.gitRoot, task.git_branch)) {
    throw new ValidationError(`任務分支不存在：${task.git_branch}`);
  }

  const status = getTaskGitStatus(projectId, taskId);
  if (!status.merge_targets.includes(targetBranch)) {
    throw new ValidationError(`無法 merge 到分支：${targetBranch}`);
  }
  if (!status.can_merge && status.merge_block_reason) {
    throw new ValidationError(status.merge_block_reason);
  }
  if (isBranchMergedInto(project.gitRoot, task.git_branch, targetBranch)) {
    throw new AlreadyMergedError(`此任務分支已合入 ${targetBranch}，無需重複 merge`);
  }

  const result = mergeBranch(project.gitRoot, task.git_branch, targetBranch);
  if (!result.ok) {
    if (result.conflicts?.length) {
      throw new MergeConflictError(result.error, result.conflicts);
    }
    throw new ValidationError(result.error);
  }

  updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      fm.merged_into = targetBranch;
      fm.merged_at = now();
      logActivity(project.workspacePath, projectId, taskId, 'human', 'updated', {
        summary: `已 merge ${task.git_branch} → ${targetBranch}`,
      });
      return { frontmatter: fm, body };
    },
    'human',
  );

  return getTask(projectId, taskId);
}

export function deleteTaskBranch(projectId: string, taskId: string) {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);

  if (!project.gitRoot) {
    throw new ValidationError('此專案未偵測到 git 倉庫');
  }
  if (!task.humanReviewed) {
    throw new ValidationError('請先驗收通過後再刪除分支');
  }
  if (!task.git_branch) {
    throw new ValidationError('此任務沒有關聯分支');
  }

  const status = getTaskGitStatus(projectId, taskId);
  if (!status.can_delete_branch && status.delete_branch_block_reason) {
    throw new ValidationError(status.delete_branch_block_reason);
  }

  const branchName = task.git_branch;
  const deletion = deleteLocalBranch(project.gitRoot, branchName);
  if (!deletion.ok) {
    throw new ValidationError(deletion.error);
  }

  updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      logActivity(project.workspacePath, projectId, taskId, 'human', 'updated', {
        summary: `已刪除分支 ${branchName}`,
      });
      fm.git_branch = null;
      return { frontmatter: fm, body };
    },
    'human',
  );

  return getTask(projectId, taskId);
}

export function restoreTaskWorktree(projectId: string, taskId: string) {
  const project = getProject(projectId);
  const task = getTask(projectId, taskId);

  if (!project.gitRoot) {
    throw new ValidationError('此專案未偵測到 git 倉庫');
  }
  if (!task.git_branch) {
    throw new ValidationError('此任務沒有關聯分支');
  }

  const status = getTaskGitStatus(projectId, taskId);
  if (!status.can_restore_worktree && status.restore_worktree_block_reason) {
    throw new ValidationError(status.restore_worktree_block_reason);
  }

  const isolation = ensureTaskWorktree(project.gitRoot, projectId, taskId, {
    git_branch: task.git_branch,
    worktree_path: null,
    isolation_status: 'removed',
    isolation_base_sha: task.isolation_base_sha,
  });

  if (isolation.isolation_status === 'failed') {
    throw new ValidationError(isolation.isolation_error ?? '無法恢復 worktree');
  }

  updateTaskInternal(
    projectId,
    taskId,
    (fm, body) => {
      fm.git_branch = isolation.git_branch;
      fm.worktree_path = isolation.worktree_path;
      fm.isolation_base_sha = isolation.isolation_base_sha;
      fm.isolation_status = 'ready';
      fm.isolation_error = null;
      logActivity(project.workspacePath, projectId, taskId, 'human', 'updated', {
        summary: `已恢復隔離 worktree：${isolation.git_branch}`,
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

function cleanupTaskGitForDelete(
  gitRoot: string,
  projectId: string,
  task: {
    id: string;
    git_branch?: string | null;
    worktree_path?: string | null;
  },
  options: { force?: boolean } = {},
): string[] {
  const warnings: string[] = [];
  const worktreePaths = new Set<string>();
  if (task.worktree_path) worktreePaths.add(task.worktree_path);
  worktreePaths.add(worktreePathForTask(gitRoot, projectId, task.id));

  for (const wt of worktreePaths) {
    if (!wt) continue;
    const removal = removeTaskWorktree(gitRoot, wt);
    if (!removal.ok && fs.existsSync(wt)) {
      if (options.force) {
        warnings.push(removal.error ?? `無法移除 worktree：${wt}`);
      } else {
        throw new ValidationError(removal.error ?? '無法移除 worktree');
      }
    }
  }

  const branchCandidates = new Set<string>();
  if (task.git_branch) branchCandidates.add(task.git_branch);
  branchCandidates.add(taskBranchName(task.id));
  branchCandidates.add(taskTempBranchName(task.id));

  for (const branch of branchCandidates) {
    if (!localBranchExists(gitRoot, branch)) continue;
    const deletion = forceDeleteLocalBranch(gitRoot, branch);
    if (!deletion.ok) {
      if (options.force) {
        warnings.push(deletion.error);
      } else {
        throw new ValidationError(deletion.error);
      }
    }
  }

  return warnings;
}

export async function deleteTask(
  projectId: string,
  taskId: string,
  options: { force?: boolean } = {},
) {
  const project = getProject(projectId);
  const filePath = getTaskFilePath(project.workspacePath, taskId);
  if (!fs.existsSync(filePath)) {
    throw new NotFoundError('任務不存在');
  }

  const { frontmatter } = readTaskFile(filePath);
  if (frontmatter.status === 'in_progress') {
    throw new ValidationError('處理中的任務無法刪除，請先取消任務或等待 Agent 完成');
  }

  const taskUid = frontmatter.uid;
  await stopPreview(taskUid).catch(() => undefined);
  if (process.platform === 'win32') {
    await new Promise((r) => setTimeout(r, 500));
  }

  return withWriteLock(project.workspacePath, () => {
    let warnings: string[] = [];
    if (project.gitRoot) {
      warnings = cleanupTaskGitForDelete(
        project.gitRoot,
        projectId,
        {
          id: taskId,
          git_branch: frontmatter.git_branch,
          worktree_path: frontmatter.worktree_path,
        },
        { force: options.force },
      );
    }

    const commentsPath = getCommentsFilePath(project.workspacePath, taskId);
    if (fs.existsSync(commentsPath)) {
      fs.unlinkSync(commentsPath);
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    const db = getDb();
    db.delete(schema.previewServers).where(eq(schema.previewServers.taskUid, taskUid)).run();
    db.delete(schema.leases).where(eq(schema.leases.taskUid, taskUid)).run();
    db.delete(schema.comments)
      .where(and(eq(schema.comments.projectId, projectId), eq(schema.comments.taskId, taskId)))
      .run();
    db.delete(schema.activityLogs)
      .where(and(eq(schema.activityLogs.projectId, projectId), eq(schema.activityLogs.taskId, taskId)))
      .run();
    db.delete(schema.tasks).where(eq(schema.tasks.uid, taskUid)).run();

    return { deleted: true, id: taskId, warnings: warnings.length > 0 ? warnings : undefined };
  });
}

function worktreeBaseDirForProject(gitRoot: string, projectId: string): string {
  const parent = path.dirname(gitRoot);
  const shortId = projectId.replace(/-/g, '').slice(0, 8);
  return path.join(parent, '.pm-ai-worktrees', shortId);
}

function removePathOrWarn(
  targetPath: string,
  options: { force?: boolean; label?: string },
): string | null {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) return null;

  const rmOpts: fs.RmOptions = {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 8 : 3,
    retryDelay: process.platform === 'win32' ? 300 : 100,
  };

  const fail = (err: unknown): string | null => {
    const message = err instanceof Error ? err.message : String(err);
    const label = options.label ?? resolved;
    const text = `無法刪除 ${label}：${message}`;
    if (options.force) return text;
    throw new ValidationError(text);
  };

  try {
    fs.rmSync(resolved, rmOpts);
    return null;
  } catch (err) {
    if (process.platform !== 'win32') return fail(err);
  }

  try {
    const trash = `${resolved}.pm-ai-del-${Date.now()}`;
    fs.renameSync(resolved, trash);
    fs.rmSync(trash, rmOpts);
    return null;
  } catch (err) {
    return fail(err);
  }
}

interface TaskDeleteSnapshot {
  id: string;
  uid: string;
  status: string;
  git_branch?: string | null;
  worktree_path?: string | null;
}

function collectTasksForProjectDelete(projectId: string, workspacePath: string): TaskDeleteSnapshot[] {
  const byId = new Map<string, TaskDeleteSnapshot>();

  if (fs.existsSync(workspacePath) && checkProjectBinding(workspacePath) === 'ok') {
    for (const filePath of listTaskFiles(workspacePath)) {
      try {
        const { frontmatter } = readTaskFile(filePath);
        byId.set(frontmatter.id, {
          id: frontmatter.id,
          uid: frontmatter.uid,
          status: frontmatter.status,
          git_branch: frontmatter.git_branch,
          worktree_path: frontmatter.worktree_path,
        });
      } catch {
        // skip malformed task files
      }
    }
  }

  const db = getDb();
  const rows = db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId)).all();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: row.id,
        uid: row.uid,
        status: row.status,
      });
    }
  }

  return [...byId.values()];
}

export async function deleteProject(projectId: string, options: { force?: boolean } = {}) {
  const project = getProject(projectId);
  const tasksToClean = collectTasksForProjectDelete(projectId, project.workspacePath);

  const inProgress = tasksToClean.filter((task) => task.status === 'in_progress');
  if (inProgress.length > 0) {
    throw new ValidationError(
      `有 ${inProgress.length} 個處理中的任務，請先取消或等待完成後再刪除專案`,
    );
  }

  await stopPreviewsForProject(projectId);
  if (process.platform === 'win32') {
    await new Promise((r) => setTimeout(r, 500));
  }

  const runDelete = () => {
    const warnings: string[] = [];

    if (project.gitRoot) {
      for (const task of tasksToClean) {
        warnings.push(
          ...cleanupTaskGitForDelete(project.gitRoot!, projectId, task, { force: options.force }),
        );
      }

      const wtBase = worktreeBaseDirForProject(project.gitRoot, projectId);
      const wtWarning = removePathOrWarn(wtBase, {
        force: options.force,
        label: `worktree 目錄 ${wtBase}`,
      });
      if (wtWarning) warnings.push(wtWarning);
      runGit(project.gitRoot, ['worktree', 'prune']);
    }

    const pmAiDir = getPmAiDir(project.workspacePath);
    const pmAiWarning = removePathOrWarn(pmAiDir, {
      force: options.force,
      label: `workspace 資料目錄 ${pmAiDir}`,
    });
    if (pmAiWarning) warnings.push(pmAiWarning);

    const db = getDb();
    db.delete(schema.previewServers).where(eq(schema.previewServers.projectId, projectId)).run();

    const taskUids = tasksToClean.map((task) => task.uid);
    if (taskUids.length > 0) {
      db.delete(schema.leases).where(inArray(schema.leases.taskUid, taskUids)).run();
    }

    db.delete(schema.comments).where(eq(schema.comments.projectId, projectId)).run();
    db.delete(schema.activityLogs).where(eq(schema.activityLogs.projectId, projectId)).run();
    db.delete(schema.tasks).where(eq(schema.tasks.projectId, projectId)).run();
    db.delete(schema.projects).where(eq(schema.projects.id, projectId)).run();

    return {
      deleted: true,
      id: projectId,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  };

  if (fs.existsSync(project.workspacePath)) {
    return withWriteLock(project.workspacePath, runDelete);
  }
  return runDelete();
}
