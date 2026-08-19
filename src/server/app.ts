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
  TASK_STATUSES,
  STATUS_LABELS,
  PORT,
} from '../shared/schemas.js';
import * as taskService from './services/tasks.js';
import { getTaskChanges, getTaskFileDiff } from './services/changes.js';
import { stopAllPreviews } from './services/preview.js';
import {
  ConflictError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from './services/tasks.js';

type Variables = {
  actor: 'human' | 'agent';
};

const app = new Hono<{ Variables: Variables }>();

app.use(
  '*',
  cors({
    origin: ['http://127.0.0.1:7432', 'http://localhost:7432', 'http://127.0.0.1:5173', 'http://localhost:5173'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-PM-AI-Actor'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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
  if (err instanceof ValidationError) {
    return c.json({ error: err.message, code: 'VALIDATION' }, 400);
  }
  console.error(err);
  return c.json({ error: '內部錯誤', code: 'INTERNAL' }, 500);
}

function authMiddleware(actor: 'human' | 'agent' | 'any') {
  return async (c: Context<{ Variables: Variables }>, next: Next) => {
    const host = c.req.header('host') ?? '';
    if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
      return c.json({ error: 'Forbidden host', code: 'FORBIDDEN' }, 403);
    }

    const config = getConfig();
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (token !== config.token) {
      return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }

    const actorHeader = c.req.header('x-pm-ai-actor') as 'human' | 'agent' | undefined;
    const resolvedActor = actorHeader ?? 'human';

    if (actor === 'human' && resolvedActor !== 'human') {
      return c.json({ error: '此端點僅限人使用', code: 'FORBIDDEN' }, 403);
    }
    if (actor === 'agent' && resolvedActor !== 'agent') {
      return c.json({ error: '此端點僅限 Agent 使用', code: 'FORBIDDEN' }, 403);
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

// Bootstrap config (localhost only, no auth - UI needs token on first load)
app.get('/api/v1/config', (c) => {
  const host = c.req.header('host') ?? '';
  if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
    return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
  }
  const config = getConfig();
  return c.json({ baseUrl: config.baseUrl, port: config.port, token: config.token });
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
    return c.json(taskService.createProject(body), 201);
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
    const actor = c.get('actor') ?? 'human';
    return c.json(taskService.createTask(requireParam(c, 'id'), body, actor), 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Agent inbox
app.get('/api/v1/inbox', authMiddleware('agent'), (c) => {
  try {
    return c.json(taskService.getInbox());
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
      const actor = c.get('actor') ?? 'human';
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
  console.log(`PM-AI 啟動於 ${config.baseUrl}`);
  console.log(`Token 儲存於 %APPDATA%/pm-ai/config.json`);

  const shutdown = () => {
    void stopAllPreviews().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.port,
  });

  if (process.platform === 'win32') {
    exec(`start ${config.baseUrl}`);
  }
}

export { app };
