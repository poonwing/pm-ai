import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { z } from 'zod';
import { getConfig, regenerateToken } from './config.js';
import {
  BIND_HOST,
  buildAccessUrls,
  isAllowedCorsOrigin,
  isAllowedRequestHost,
  isLanMode,
} from './network.js';
import { pickFolder } from './services/pick-folder.js';
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  RelocateProjectSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  ClaimTaskSchema,
  HeartbeatSchema,
  ProgressSchema,
  CompleteTaskSchema,
  ReleaseTaskSchema,
  RejectReviewSchema,
  CancelTaskSchema,
  CreateCommentSchema,
  CheckoutBranchSchema,
  MergeTaskBranchSchema,
  CreateStaffAgentSchema,
  UpdateStaffAgentSchema,
  CreateAutoRunSchema,
  AutoRunMessageSchema,
  ResolveDecisionSchema,
  UpdateReviewPolicySchema,
  UpdateRequirementsSchema,
  AnalyzeRequirementsSchema,
  CreateDesignSchema,
  UpdateDesignSchema,
  GenerateDesignSchema,
  CreateChatSessionSchema,
  SendChatMessageSchema,
  TASK_STATUSES,
  STATUS_LABELS,
  PORT,
} from '../shared/schemas.js';
import * as taskService from './services/tasks.js';
import { getTaskChanges, getTaskFileDiff } from './services/changes.js';
import { stopAllPreviews } from './services/preview.js';
import {
  checkoutWorkspaceBranch,
  getWorkspaceGitStatus,
} from './services/workspace-git.js';
import { listWorkspaceDir, readWorkspaceFile } from './services/workspace-files.js';
import {
  ConflictError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  MergeConflictError,
  AlreadyMergedError,
} from './services/tasks.js';
import * as agentsService from './services/agents.js';
import * as autoService from './services/auto.js';
import * as orchestrator from './orchestrator/index.js';
import { isModelConfigured } from './orchestrator/model.js';
import {
  getRunnerStatus,
  getRunnerLogs,
  getLatestRunnerJobForTask,
  subscribeRunnerLogs,
} from './runner/index.js';
import * as requirementsService from './services/requirements.js';
import * as designsService from './services/designs.js';
import * as chatService from './services/chat.js';
import { getChatStream, subscribeChatStream } from './services/chat-stream.js';

type Variables = {
  actor: 'human' | 'agent' | 'orchestrator';
};

const app = new Hono<{ Variables: Variables }>();

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return isLanMode() ? '*' : 'http://127.0.0.1:7432';
      const config = getConfig();
      if (isAllowedCorsOrigin(origin, config.port)) return origin;
      const localhostOrigins = [
        `http://127.0.0.1:${PORT}`,
        `http://localhost:${PORT}`,
        'http://127.0.0.1:5173',
        'http://localhost:5173',
      ];
      if (localhostOrigins.includes(origin)) return origin;
      return null;
    },
    allowHeaders: ['Authorization', 'Content-Type', 'X-PM-AI-Actor'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);

function requireParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new ValidationError(`缺少參數 ${name}`);
  return value;
}

function requireProjectId(c: Context): string {
  const projectId = c.req.query('project_id');
  if (!projectId) throw new ValidationError('需要 project_id 參數');
  return projectId;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || '內部錯誤';
  if (typeof err === 'string') return err;
  if (err == null) return '內部錯誤';
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Avoid Node util.inspect crashes on exotic thrown values (e.g. some native / SDK errors). */
function logServerError(err: unknown) {
  try {
    if (err == null) {
      console.error('[pm-ai] internal error (null/undefined)');
      return;
    }
    if (err instanceof Error) {
      console.error(`[pm-ai] ${err.name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
      return;
    }
    console.error('[pm-ai]', extractErrorMessage(err));
  } catch {
    console.error('[pm-ai] internal error (could not format)');
  }
}

function errorResponse(c: Context, err: unknown) {
  if (err instanceof NotFoundError) {
    return c.json({ error: err.message, code: 'NOT_FOUND' }, 404);
  }
  if (err instanceof ConflictError) {
    return c.json({ error: err.message, code: 'CONFLICT', current: err.current }, 409);
  }
  if (err instanceof ForbiddenError) {
    return c.json({ error: err.message, code: 'FORBIDDEN' }, 403);
  }
  if (err instanceof MergeConflictError) {
    return c.json(
      { error: err.message, code: 'MERGE_CONFLICT', conflicts: err.conflicts },
      409,
    );
  }
  if (err instanceof AlreadyMergedError) {
    return c.json({ error: err.message, code: 'ALREADY_MERGED' }, 400);
  }
  if (err instanceof ValidationError) {
    return c.json({ error: err.message, code: 'VALIDATION' }, 400);
  }
  logServerError(err);
  return c.json({ error: extractErrorMessage(err), code: 'INTERNAL' }, 500);
}

function authMiddleware(actor: 'human' | 'agent' | 'orchestrator' | 'any' | 'human_or_orchestrator') {
  return async (c: Context<{ Variables: Variables }>, next: Next) => {
    const host = c.req.header('host') ?? '';
    if (!isAllowedRequestHost(host)) {
      return c.json({ error: 'Forbidden host', code: 'FORBIDDEN' }, 403);
    }

    const config = getConfig();
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (token !== config.token) {
      return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }

    const actorHeader = c.req.header('x-pm-ai-actor') as
      | 'human'
      | 'agent'
      | 'orchestrator'
      | undefined;
    const resolvedActor = actorHeader ?? 'human';

    if (actor === 'human' && resolvedActor !== 'human') {
      return c.json({ error: '此端點僅限人使用', code: 'FORBIDDEN' }, 403);
    }
    if (actor === 'agent' && resolvedActor !== 'agent') {
      return c.json({ error: '此端點僅限 Agent 使用', code: 'FORBIDDEN' }, 403);
    }
    if (actor === 'orchestrator' && resolvedActor !== 'orchestrator') {
      return c.json({ error: '此端點僅限協調者使用', code: 'FORBIDDEN' }, 403);
    }
    if (
      actor === 'human_or_orchestrator' &&
      resolvedActor !== 'human' &&
      resolvedActor !== 'orchestrator'
    ) {
      return c.json({ error: '此端點僅限人或協調者', code: 'FORBIDDEN' }, 403);
    }

    c.set('actor', resolvedActor);
    await next();
  };
}

// Public
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/v1/meta', (c) => {
  const config = getConfig();
  return c.json({
    version: '0.1.0',
    port: config.port,
    baseUrl: config.baseUrl,
    statuses: TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    openapi: `${config.baseUrl}/api/v1/openapi.json`,
  });
});

app.get('/api/v1/openapi.json', (c) => {
  return c.json({
    openapi: '3.0.0',
    info: { title: 'PM-AI API', version: '0.1.0' },
    servers: [{ url: `http://127.0.0.1:${PORT}/api/v1` }],
    paths: {
      '/health': { get: { summary: 'Health check' } },
      '/inbox': { get: { summary: 'Agent inbox (todo tasks)' } },
      '/projects': { get: { summary: 'List projects' }, post: { summary: 'Create project' } },
      '/tasks/{id}': { get: { summary: 'Get task' } },
      '/tasks/{id}/claim': { post: { summary: 'Claim task (agent)' } },
      '/tasks/{id}/complete': { post: { summary: 'Complete task (agent)' } },
    },
  });
});

// Bootstrap config (private network only, no auth - UI needs token on first load)
app.get('/api/v1/config', (c) => {
  const host = c.req.header('host') ?? '';
  if (!isAllowedRequestHost(host)) {
    return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
  }
  const config = getConfig();
  const urls = buildAccessUrls(config.port);
  return c.json({
    baseUrl: config.baseUrl,
    port: config.port,
    token: config.token,
    lanMode: isLanMode(),
    lanUrls: urls.lan,
  });
});

app.post('/api/v1/config/regenerate-token', authMiddleware('human'), (c) => {
  const config = regenerateToken();
  return c.json({ token: config.token });
});

app.post(
  '/api/v1/dialogs/pick-folder',
  authMiddleware('human'),
  zValidator('json', z.object({ initial_path: z.string().optional() })),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const selected = await pickFolder(body.initial_path);
      return c.json({ cancelled: selected === null, path: selected });
    } catch (err) {
      if (err instanceof Error && !(err instanceof ValidationError)) {
        return errorResponse(c, new ValidationError(err.message));
      }
      return errorResponse(c, err);
    }
  },
);

// Projects
app.get('/api/v1/projects', authMiddleware('any'), (c) => {
  try {
    return c.json(taskService.listProjects());
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id', authMiddleware('any'), (c) => {
  try {
    return c.json(taskService.getProject(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/dashboard', authMiddleware('any'), (c) => {
  try {
    return c.json(taskService.getDashboard(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/projects', authMiddleware('human'), zValidator('json', CreateProjectSchema), (c) => {
  try {
    const body = c.req.valid('json');
    const project = taskService.createProject(body);
    agentsService.ensureDefaultStaffAgents(project.id);
    return c.json(project, 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.patch('/api/v1/projects/:id', authMiddleware('human'), zValidator('json', UpdateProjectSchema), (c) => {
  try {
    const body = c.req.valid('json');
    return c.json(taskService.updateProject(requireParam(c, 'id'), body));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.delete('/api/v1/projects/:id', authMiddleware('human'), async (c) => {
  try {
    const force = c.req.query('force') === '1' || c.req.query('force') === 'true';
    const result = await taskService.deleteProject(requireParam(c, 'id'), { force });
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/projects/:id/relocate', authMiddleware('human'), zValidator('json', RelocateProjectSchema), (c) => {
  try {
    const body = c.req.valid('json');
    return c.json(taskService.relocateProject(requireParam(c, 'id'), body.workspace_path));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/projects/:id/skill/reinstall', authMiddleware('human'), (c) => {
  try {
    return c.json(taskService.reinstallProjectSkill(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/projects/:id/initialize', authMiddleware('human'), (c) => {
  try {
    return c.json(taskService.initializeProject(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/git', authMiddleware('human'), (c) => {
  try {
    return c.json(getWorkspaceGitStatus(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/projects/:id/git/checkout',
  authMiddleware('human'),
  zValidator('json', CheckoutBranchSchema),
  (c) => {
    try {
      const body = c.req.valid('json');
      return c.json(checkoutWorkspaceBranch(requireParam(c, 'id'), body.branch));
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/projects/:id/files/content', authMiddleware('human'), (c) => {
  try {
    const pathParam = c.req.query('path');
    if (!pathParam) throw new ValidationError('需要 path 參數');
    return c.json(readWorkspaceFile(requireParam(c, 'id'), pathParam));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/files', authMiddleware('human'), (c) => {
  try {
    const pathParam = c.req.query('path') ?? '';
    return c.json(listWorkspaceDir(requireParam(c, 'id'), pathParam));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Tasks - list & create
app.get('/api/v1/projects/:id/tasks', authMiddleware('any'), (c) => {
  try {
    const status = c.req.query('status') as import('../shared/schemas.js').TaskStatus | undefined;
    return c.json(taskService.listProjectTasks(requireParam(c, 'id'), status));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/projects/:id/tasks', authMiddleware('any'), zValidator('json', CreateTaskSchema), (c) => {
  try {
    const body = c.req.valid('json');
    const raw = c.get('actor') ?? 'human';
    const actor = raw === 'agent' || raw === 'orchestrator' ? 'agent' : 'human';
    return c.json(taskService.createTask(requireParam(c, 'id'), body, actor), 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Agent inbox
app.get('/api/v1/inbox', authMiddleware('agent'), (c) => {
  try {
    return c.json(
      taskService.getInbox({
        assignee_agent_id: c.req.query('assignee_agent_id') ?? undefined,
        agent_name: c.req.query('agent_name') ?? undefined,
        project_id: c.req.query('project_id') ?? undefined,
      }),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Single task
app.get('/api/v1/tasks/:id', authMiddleware('any'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.getTask(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/tasks/:id/comments', authMiddleware('any'), (c) => {
  try {
    const projectId = requireProjectId(c);
    return c.json(taskService.listComments(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/tasks/:id/comments',
  authMiddleware('any'),
  zValidator('json', CreateCommentSchema),
  (c) => {
    try {
      const projectId = requireProjectId(c);
      const raw = c.get('actor') ?? 'human';
      const actor = raw === 'agent' || raw === 'orchestrator' ? 'agent' : 'human';
      const body = c.req.valid('json');
      return c.json(
        taskService.addComment(projectId, requireParam(c, 'id'), body, actor),
        201,
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.patch('/api/v1/tasks/:id', authMiddleware('human'), zValidator('json', UpdateTaskSchema), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const body = c.req.valid('json');
    return c.json(taskService.updateTaskContent(projectId, requireParam(c, 'id'), body));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Human task actions
app.post('/api/v1/tasks/:id/publish', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.publishTask(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/cancel', authMiddleware('human'), zValidator('json', CancelTaskSchema), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const body = c.req.valid('json');
    return c.json(taskService.cancelTask(projectId, requireParam(c, 'id'), body.reason));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/reopen', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.reopenTask(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/review/approve', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.approveReview(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/review/reject', authMiddleware('human'), zValidator('json', RejectReviewSchema), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const body = c.req.valid('json');
    return c.json(taskService.rejectReview(projectId, requireParam(c, 'id'), body.reason));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/unlock', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.forceUnlockTask(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.delete('/api/v1/tasks/:id', authMiddleware('human'), async (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const force = c.req.query('force') === '1' || c.req.query('force') === 'true';
    const result = await taskService.deleteTask(projectId, requireParam(c, 'id'), { force });
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/isolation/retry', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.retryTaskIsolation(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/isolation/remove', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.removeTaskIsolation(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/tasks/:id/git', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.getTaskGitStatus(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/tasks/:id/git/merge',
  authMiddleware('human'),
  zValidator('json', MergeTaskBranchSchema),
  (c) => {
    try {
      const projectId = c.req.query('project_id');
      if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
      const body = c.req.valid('json');
      return c.json(
        taskService.mergeTaskBranch(projectId, requireParam(c, 'id'), body.target_branch),
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.post('/api/v1/tasks/:id/git/remove-worktree', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.removeTaskIsolation(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/git/delete-branch', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.deleteTaskBranch(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/git/restore-worktree', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.restoreTaskWorktree(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/git/switch-temp-branch', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.switchTaskWorktreeToTempBranch(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/git/restore-task-branch', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.restoreTaskWorktreeFromTempBranch(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/isolation/open-cursor', authMiddleware('human'), async (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const result = await taskService.openTaskInCursor(projectId, requireParam(c, 'id'));
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/tasks/:id/preview', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(taskService.getTaskPreview(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/preview/start', authMiddleware('human'), async (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const task = await taskService.startTaskPreview(projectId, requireParam(c, 'id'));
    return c.json(task);
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/preview/stop', authMiddleware('human'), async (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const task = await taskService.stopTaskPreview(projectId, requireParam(c, 'id'));
    return c.json(task);
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/tasks/:id/runner/logs', authMiddleware('any'), (c) => {
  try {
    const projectId = requireProjectId(c);
    const taskId = requireParam(c, 'id');
    const sinceSeq = Number(c.req.query('since_seq') ?? '0') || 0;
    const { entries, latestSeq } = getRunnerLogs(projectId, taskId, sinceSeq);
    const job = getLatestRunnerJobForTask(projectId, taskId);
    return c.json({ entries, latestSeq, job });
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/tasks/:id/runner/stream', authMiddleware('any'), (c) => {
  try {
    const projectId = requireProjectId(c);
    const taskId = requireParam(c, 'id');
    const sinceSeq = Number(c.req.query('since_seq') ?? '0') || 0;
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let jobTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (jobTimer) clearInterval(jobTimer);
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        };

        const { entries, latestSeq } = getRunnerLogs(projectId, taskId, sinceSeq);
        let lastSeq = latestSeq;
        send('init', { entries, latestSeq, job: getLatestRunnerJobForTask(projectId, taskId) });

        unsubscribe = subscribeRunnerLogs(projectId, taskId, (entry) => {
          send('log', entry);
          lastSeq = entry.seq;
        });

        heartbeatTimer = setInterval(() => {
          send('ping', { at: new Date().toISOString(), latestSeq: lastSeq });
        }, 15000);

        jobTimer = setInterval(() => {
          const job = getLatestRunnerJobForTask(projectId, taskId);
          if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) {
            send('done', { job, latestSeq: lastSeq });
            cleanup(controller);
          }
        }, 2000);
      },
      cancel() {
        closed = true;
        unsubscribe?.();
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (jobTimer) clearInterval(jobTimer);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/tasks/:id/changes', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    return c.json(getTaskChanges(projectId, requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/tasks/:id/changes/diff', authMiddleware('human'), (c) => {
  try {
    const projectId = c.req.query('project_id');
    const filePath = c.req.query('path');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    if (!filePath) return c.json({ error: '需要 path 參數', code: 'VALIDATION' }, 400);
    return c.json(getTaskFileDiff(projectId, requireParam(c, 'id'), filePath));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Agent task actions
app.post('/api/v1/tasks/:id/claim', authMiddleware('agent'), zValidator('json', ClaimTaskSchema), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const body = c.req.valid('json');
    return c.json(
      taskService.claimTask(projectId, requireParam(c, 'id'), body.agent_name, body.expected_version),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/heartbeat', authMiddleware('agent'), zValidator('json', HeartbeatSchema), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const body = c.req.valid('json');
    return c.json(
      taskService.heartbeatTask(projectId, requireParam(c, 'id'), body.agent_name, body.lease_token),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/progress', authMiddleware('agent'), zValidator('json', ProgressSchema), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const body = c.req.valid('json');
    return c.json(
      taskService.progressTask(
        projectId,
        requireParam(c, 'id'),
        body.agent_name,
        body.lease_token,
        body.summary,
      ),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/complete', authMiddleware('agent'), zValidator('json', CompleteTaskSchema), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const body = c.req.valid('json');
    return c.json(
      taskService.completeTask(
        projectId,
        requireParam(c, 'id'),
        body.agent_name,
        body.lease_token,
        body.result_note,
        body.artifacts,
      ),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/tasks/:id/release', authMiddleware('agent'), zValidator('json', ReleaseTaskSchema), (c) => {
  try {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: '需要 project_id 參數', code: 'VALIDATION' }, 400);
    const body = c.req.valid('json');
    return c.json(
      taskService.releaseTask(
        projectId,
        requireParam(c, 'id'),
        body.agent_name,
        body.lease_token,
        body.reason,
      ),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

// --- Auto mode: staff agents, runs, decisions, meetings, policy ---

app.get('/api/v1/meta/model', authMiddleware('any'), (c) => {
  return c.json({ configured: isModelConfigured() });
});

app.get('/api/v1/projects/:id/agents', authMiddleware('any'), (c) => {
  try {
    agentsService.ensureDefaultStaffAgents(requireParam(c, 'id'));
    return c.json(agentsService.listStaffAgents(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/projects/:id/agents',
  authMiddleware('human_or_orchestrator'),
  zValidator('json', CreateStaffAgentSchema),
  (c) => {
    try {
      const actor = c.get('actor');
      const createdBy = actor === 'orchestrator' ? 'orchestrator' : 'human';
      return c.json(
        agentsService.createStaffAgent(requireParam(c, 'id'), c.req.valid('json'), createdBy),
        201,
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/agents/:id', authMiddleware('any'), (c) => {
  try {
    return c.json(agentsService.getStaffAgent(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.patch(
  '/api/v1/agents/:id',
  authMiddleware('human_or_orchestrator'),
  zValidator('json', UpdateStaffAgentSchema),
  (c) => {
    try {
      const editor = c.get('actor') === 'orchestrator' ? 'orchestrator' : 'human';
      return c.json(agentsService.updateStaffAgent(requireParam(c, 'id'), c.req.valid('json'), editor));
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.post('/api/v1/agents/:id/retire', authMiddleware('human'), (c) => {
  try {
    return c.json(agentsService.retireStaffAgent(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/runs', authMiddleware('any'), (c) => {
  try {
    return c.json(autoService.listAutoRuns(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/projects/:id/runs',
  authMiddleware('human'),
  zValidator('json', CreateAutoRunSchema),
  async (c) => {
    try {
      const projectId = requireParam(c, 'id');
      taskService.updateProject(projectId, { run_mode: 'auto' });
      const body = c.req.valid('json');
      const result = await orchestrator.startOrchestratorRun(projectId, body.goal);
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/runs/:id', authMiddleware('any'), (c) => {
  try {
    const run = autoService.getAutoRun(requireParam(c, 'id'));
    return c.json({
      run,
      messages: autoService.getAutoRunMessages(run.id),
      decisions: autoService.listDecisions(run.project_id, 'open').filter((d) => d.run_id === run.id),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/runs/:id/debug', authMiddleware('any'), async (c) => {
  try {
    return c.json(await orchestrator.getRunDebugSnapshot(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/runs/:id/pause', authMiddleware('human'), (c) => {
  try {
    return c.json(autoService.pauseAutoRun(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/runs/:id/resume', authMiddleware('human'), async (c) => {
  try {
    const run = autoService.resumeAutoRun(requireParam(c, 'id'));
    const result = await orchestrator.tickOrchestrator(run.id);
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post('/api/v1/runs/:id/stop', authMiddleware('human'), (c) => {
  try {
    return c.json(orchestrator.requestStop(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/runs/:id/message',
  authMiddleware('human'),
  zValidator('json', AutoRunMessageSchema),
  async (c) => {
    try {
      const result = await orchestrator.messageOrchestrator(
        requireParam(c, 'id'),
        c.req.valid('json').message,
      );
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.post('/api/v1/runs/:id/tick', authMiddleware('human'), async (c) => {
  try {
    return c.json(await orchestrator.tickOrchestrator(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/decisions', authMiddleware('any'), (c) => {
  try {
    return c.json(
      autoService.listDecisions(requireParam(c, 'id'), c.req.query('status') ?? undefined),
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/decisions/:id/resolve',
  authMiddleware('human'),
  zValidator('json', ResolveDecisionSchema),
  async (c) => {
    try {
      const id = requireParam(c, 'id');
      const body = c.req.valid('json');
      const before = autoService.getDecision(id);
      const decision = autoService.resolveDecision(id, body.chosen_option_id, body.note);
      if (before.title.includes('Review Policy') && decision.run_id) {
        const result = await orchestrator.handlePolicyDecision(id, body.chosen_option_id);
        return c.json({ decision, ...result });
      }
      if (decision.run_id) {
        const result = await orchestrator.tickOrchestrator(decision.run_id);
        return c.json({ decision, ...result });
      }
      return c.json({ decision });
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/projects/:id/meetings', authMiddleware('any'), (c) => {
  try {
    return c.json(autoService.listMeetings(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/meetings/:id', authMiddleware('any'), (c) => {
  try {
    return c.json(autoService.getMeeting(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/review-policy', authMiddleware('any'), (c) => {
  try {
    return c.json(autoService.getReviewPolicy(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/runner/status', authMiddleware('any'), (c) => {
  try {
    return c.json(getRunnerStatus(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/requirements', authMiddleware('human'), (c) => {
  try {
    return c.json(requirementsService.getRequirements(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.put(
  '/api/v1/projects/:id/requirements',
  authMiddleware('human'),
  zValidator('json', UpdateRequirementsSchema),
  (c) => {
    try {
      return c.json(requirementsService.saveRequirements(requireParam(c, 'id'), c.req.valid('json').markdown));
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/projects/:id/requirements/download', authMiddleware('human'), (c) => {
  try {
    const { markdown, filename } = requirementsService.getRequirementsDownload(requireParam(c, 'id'));
    return c.text(markdown, 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/requirements/messages', authMiddleware('human'), (c) => {
  try {
    return c.json(requirementsService.getRequirementsMessages(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/projects/:id/requirements/analyze',
  authMiddleware('human'),
  zValidator('json', AnalyzeRequirementsSchema),
  async (c) => {
    try {
      return c.json(await requirementsService.analyzeRequirements(requireParam(c, 'id'), c.req.valid('json')));
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/projects/:id/designs', authMiddleware('human'), (c) => {
  try {
    return c.json(designsService.listDesigns(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/projects/:id/designs',
  authMiddleware('human'),
  zValidator('json', CreateDesignSchema),
  (c) => {
    try {
      return c.json(designsService.createDesign(requireParam(c, 'id'), c.req.valid('json').title));
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/projects/:id/designs/messages', authMiddleware('human'), (c) => {
  try {
    return c.json(designsService.getDesignMessages(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/projects/:id/designs/generate',
  authMiddleware('human'),
  zValidator('json', GenerateDesignSchema),
  async (c) => {
    try {
      const body = c.req.valid('json');
      return c.json(
        await designsService.generateDesign(requireParam(c, 'id'), {
          message: body.message,
          designId: body.design_id,
          title: body.title,
        }),
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/projects/:id/designs/:designId/download', authMiddleware('human'), (c) => {
  try {
    const { html, filename } = designsService.getDesignDownload(
      requireParam(c, 'id'),
      requireParam(c, 'designId'),
    );
    return c.text(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.get('/api/v1/projects/:id/designs/:designId', authMiddleware('human'), (c) => {
  try {
    return c.json(designsService.getDesign(requireParam(c, 'id'), requireParam(c, 'designId')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.put(
  '/api/v1/projects/:id/designs/:designId',
  authMiddleware('human'),
  zValidator('json', UpdateDesignSchema),
  (c) => {
    try {
      return c.json(
        designsService.updateDesign(requireParam(c, 'id'), requireParam(c, 'designId'), c.req.valid('json')),
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.delete('/api/v1/projects/:id/designs/:designId', authMiddleware('human'), async (c) => {
  try {
    return c.json(designsService.deleteDesign(requireParam(c, 'id'), requireParam(c, 'designId')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.put(
  '/api/v1/projects/:id/review-policy',
  authMiddleware('human'),
  zValidator('json', UpdateReviewPolicySchema),
  (c) => {
    try {
      const confirm = c.req.query('confirm') === '1';
      return c.json(
        autoService.upsertReviewPolicy(requireParam(c, 'id'), c.req.valid('json'), confirm),
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

// —— Agent Chat ——
app.get('/api/v1/projects/:id/chat/sessions', authMiddleware('human'), (c) => {
  try {
    return c.json(chatService.listChatSessions(requireParam(c, 'id')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/projects/:id/chat/sessions',
  authMiddleware('human'),
  zValidator('json', CreateChatSessionSchema),
  (c) => {
    try {
      return c.json(chatService.createChatSession(requireParam(c, 'id'), c.req.valid('json')));
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/projects/:id/chat/sessions/:sid', authMiddleware('human'), (c) => {
  try {
    return c.json(chatService.getChatSession(requireParam(c, 'id'), requireParam(c, 'sid')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.delete('/api/v1/projects/:id/chat/sessions/:sid', authMiddleware('human'), (c) => {
  try {
    return c.json(chatService.deleteChatSession(requireParam(c, 'id'), requireParam(c, 'sid')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.patch(
  '/api/v1/projects/:id/chat/sessions/:sid',
  authMiddleware('human'),
  zValidator('json', z.object({ mode: z.enum(['ask', 'agent']) })),
  (c) => {
    try {
      return c.json(
        chatService.updateChatSessionMode(
          requireParam(c, 'id'),
          requireParam(c, 'sid'),
          c.req.valid('json').mode,
        ),
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/projects/:id/chat/sessions/:sid/messages', authMiddleware('human'), (c) => {
  try {
    return c.json(chatService.listChatMessages(requireParam(c, 'id'), requireParam(c, 'sid')));
  } catch (err) {
    return errorResponse(c, err);
  }
});

app.post(
  '/api/v1/projects/:id/chat/sessions/:sid/messages',
  authMiddleware('human'),
  zValidator('json', SendChatMessageSchema),
  async (c) => {
    try {
      return c.json(
        await chatService.sendChatMessage(
          requireParam(c, 'id'),
          requireParam(c, 'sid'),
          c.req.valid('json'),
        ),
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  },
);

app.get('/api/v1/projects/:id/chat/sessions/:sid/stream', authMiddleware('human'), (c) => {
  try {
    const projectId = requireParam(c, 'id');
    const sessionId = requireParam(c, 'sid');
    chatService.getChatSession(projectId, sessionId);
    const sinceSeq = Number(c.req.query('since_seq') ?? '0') || 0;
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let statusTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (statusTimer) clearInterval(statusTimer);
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        };

        const { entries, latestSeq } = getChatStream(sessionId, sinceSeq);
        let lastSeq = latestSeq;
        send('init', {
          entries,
          latestSeq,
          session: chatService.getChatSession(projectId, sessionId),
        });

        unsubscribe = subscribeChatStream(sessionId, (entry) => {
          send('event', entry);
          lastSeq = entry.seq;
          if (entry.kind === 'status' && (entry.text === 'idle' || entry.text === 'error')) {
            send('done', {
              session: chatService.getChatSession(projectId, sessionId),
              latestSeq: lastSeq,
            });
            cleanup(controller);
          }
        });

        heartbeatTimer = setInterval(() => {
          send('ping', { at: new Date().toISOString(), latestSeq: lastSeq });
        }, 15000);

        statusTimer = setInterval(() => {
          try {
            const session = chatService.getChatSession(projectId, sessionId);
            if (session.status === 'idle' || session.status === 'error') {
              send('done', { session, latestSeq: lastSeq });
              cleanup(controller);
            }
          } catch {
            cleanup(controller);
          }
        }, 2000);
      },
      cancel() {
        closed = true;
        unsubscribe?.();
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (statusTimer) clearInterval(statusTimer);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Activity status
app.get('/api/v1/activity/recent', authMiddleware('any'), (c) => {
  try {
    const activity = taskService.getRecentApiActivity();
    return c.json({ activity: activity ?? null });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Serve static UI (after `npm run build:web`)
const webDistRel = './dist/web';
app.use('/assets/*', serveStatic({ root: webDistRel }));
app.get('*', async (c, next) => {
  if (c.req.path.startsWith('/api') || c.req.path === '/health') {
    return next();
  }
  const indexPath = path.join(process.cwd(), 'dist/web/index.html');
  if (fs.existsSync(indexPath)) {
    const filePath = path.join(process.cwd(), 'dist/web', c.req.path);
    if (c.req.path !== '/' && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveStatic({ root: webDistRel })(c, next);
    }
    return c.html(fs.readFileSync(indexPath, 'utf-8'));
  }
  return c.text('UI 尚未建置，請先執行 npm run build:web', 503);
});

export function startServer() {
  const config = getConfig();
  const urls = buildAccessUrls(config.port);
  console.log(`PM-AI 啟動於 ${urls.local}`);
  if (urls.lan.length) {
    console.log('局域網訪問：');
    for (const url of urls.lan) console.log(`  ${url}`);
    console.warn('[pm-ai] LAN 模式：同一網段內的設備可訪問 UI 並取得 API Token，請確保網路環境可信');
  }
  console.log(`Token 儲存於 %APPDATA%/pm-ai/config.json`);

  const shutdown = () => {
    void stopAllPreviews().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  serve({
    fetch: app.fetch,
    hostname: BIND_HOST,
    port: config.port,
  });

  if (process.platform === 'win32') {
    exec(`start ${urls.local}`);
  }
}

export { app };
