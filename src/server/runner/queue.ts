import { v4 as uuidv4 } from 'uuid';
import { getStaffAgent } from '../services/agents.js';
import {
  claimTask,
  completeTask,
  getProject,
  getTask,
  heartbeatTask,
  progressTask,
  releaseTask,
} from '../services/tasks.js';
import { appendRunMessage } from '../services/auto.js';
import { appendRunEvent } from '../services/run-events.js';
import { readProjectConfig } from '../services/files.js';
import { runCursorSdkPrompt } from './cursor-sdk-runner.js';
import { runPiAgentPrompt } from './pi-runner.js';
import { buildRunnerPrompt } from './prompt.js';
import { isRetryableConnectionError } from '../orchestrator/model.js';
import { appendRunnerLog, updateOrAppendRunnerLog } from './logs.js';
import {
  getDefaultRunnerProvider,
  getRunnerConcurrency,
  isCursorRunnerConfigured,
  isPiRunnerConfigured,
  parseRunnerProvider,
  runnerProviderAgentName,
  runnerProviderLabel,
  type RunnerJob,
  type RunnerJobStatus,
  type RunnerProvider,
  type RunnerJobKind,
  type StudioKind,
} from './types.js';

function runPromptForProvider(
  provider: RunnerProvider,
  input: {
    prompt: string;
    cwd: string;
    taskId: string;
    name?: string;
    chatSessionId?: string;
    signal?: AbortSignal;
    onLog?: (kind: import('./logs.js').RunnerLogKind, text: string) => void;
    onAskUser?: (question: string, options?: string[]) => void | Promise<void>;
  },
) {
  if (provider === 'pi') {
    return runPiAgentPrompt({
      prompt: input.prompt,
      cwd: input.cwd,
      taskId: input.taskId,
      chatSessionId: input.chatSessionId,
      signal: input.signal,
      onLog: input.onLog,
      onAskUser: input.onAskUser,
    });
  }
  return runCursorSdkPrompt({
    prompt: input.prompt,
    cwd: input.cwd,
    name: input.name ?? `pm-ai-${input.taskId}`,
    chatSessionId: input.chatSessionId,
    signal: input.signal,
    onLog: input.onLog,
    onAskUser: input.onAskUser,
  });
}

const RUNNER_PROMPT_MAX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyRunnerTaskEvent(
  projectId: string,
  taskId: string,
  event: 'runner_failed' | 'runner_completed',
) {
  // Defer so Auto Run message/tick handlers finish before nested tick.
  setImmediate(() => {
    void import('../orchestrator/index.js')
      .then((m) => m.onTaskEvent(projectId, taskId, event))
      .catch(() => undefined);
  });
}

const jobs = new Map<string, RunnerJob>();
const queue: string[] = [];
const controllers = new Map<string, AbortController>();
const postedBlockHints = new Set<string>();
let activeCount = 0;

function now() {
  return new Date().toISOString();
}

function touch(job: RunnerJob, patch: Partial<RunnerJob>) {
  const next = { ...job, ...patch, updatedAt: now() };
  jobs.set(job.id, next);
  return next;
}

function listJobsForProject(projectId: string): RunnerJob[] {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getLatestRunnerJobForTask(
  projectId: string,
  taskId: string,
): RunnerJob | null {
  const matching = [...jobs.values()]
    .filter((j) => j.projectId === projectId && j.taskId === taskId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return matching[0] ?? null;
}

function missingKeyMessage(provider: RunnerProvider): string {
  return provider === 'pi'
    ? '未配置 ZAI_API_KEY（Pi Agent 复用 GLM Coding Plan Key）'
    : '未配置 CURSOR_API_KEY，無法啟動 Cursor SDK Runner';
}

function runnerBlockReason(provider: RunnerProvider): string | null {
  if (provider === 'pi') {
    if (!isPiRunnerConfigured()) return missingKeyMessage(provider);
    return null;
  }
  if (!isCursorRunnerConfigured()) return missingKeyMessage(provider);
  return null;
}

/** 專案 .pm-ai/project.yml 的 runner_provider，未設則回退 .env RUNNER_PROVIDER */
export function resolveRunnerProvider(projectId: string): RunnerProvider {
  try {
    const project = getProject(projectId);
    const config = readProjectConfig(project.workspacePath);
    const fromProject = parseRunnerProvider(config?.runner_provider);
    if (fromProject) return fromProject;
  } catch {
    /* fall through */
  }
  return getDefaultRunnerProvider();
}

export function getRunnerStatus(projectId: string) {
  const provider = resolveRunnerProvider(projectId);
  const hint = runnerBlockReason(provider);
  return {
    provider,
    defaultProvider: getDefaultRunnerProvider(),
    source: (() => {
      try {
        const project = getProject(projectId);
        const config = readProjectConfig(project.workspacePath);
        return parseRunnerProvider(config?.runner_provider) ? 'project' : 'env';
      } catch {
        return 'env' as const;
      }
    })(),
    configured: provider === 'pi' ? isPiRunnerConfigured() : isCursorRunnerConfigured(),
    cliInstalled: true,
    ready: hint === null,
    hint,
    concurrency: getRunnerConcurrency(provider),
    jobs: listJobsForProject(projectId),
  };
}

export function enqueueRunnerJob(input: {
  projectId: string;
  taskId?: string;
  autoRunId?: string | null;
  chatSessionId?: string | null;
  kind?: RunnerJobKind;
  studioKind?: StudioKind;
  prompt?: string;
  cwd?: string;
}): RunnerJob {
  const provider = resolveRunnerProvider(input.projectId);
  const kind: RunnerJobKind = input.kind ?? 'task';
  const taskId = input.taskId ?? '';

  if (kind === 'task' && taskId) {
    const existing = [...jobs.values()].find(
      (j) =>
        j.projectId === input.projectId &&
        j.taskId === taskId &&
        j.kind !== 'studio' &&
        j.kind !== 'chat' &&
        (j.status === 'queued' || j.status === 'claiming' || j.status === 'running'),
    );
    if (existing) return existing;
  }

  if (kind === 'studio' && input.studioKind) {
    const existing = [...jobs.values()].find(
      (j) =>
        j.projectId === input.projectId &&
        j.kind === 'studio' &&
        j.studioKind === input.studioKind &&
        (j.status === 'queued' || j.status === 'claiming' || j.status === 'running'),
    );
    if (existing) return existing;
  }

  if (kind === 'chat' && input.chatSessionId) {
    const existing = [...jobs.values()].find(
      (j) =>
        j.projectId === input.projectId &&
        j.kind === 'chat' &&
        j.chatSessionId === input.chatSessionId &&
        (j.status === 'queued' || j.status === 'claiming' || j.status === 'running'),
    );
    if (existing) return existing;
  }

  const blocked = runnerBlockReason(provider);
  if (blocked) {
    const failed: RunnerJob = {
      id: uuidv4(),
      projectId: input.projectId,
      taskId,
      autoRunId: input.autoRunId ?? null,
      chatSessionId: input.chatSessionId ?? null,
      kind,
      studioKind: input.studioKind,
      prompt: input.prompt,
      cwd: input.cwd,
      status: 'failed',
      agentName: provider,
      provider,
      error: blocked,
      createdAt: now(),
      updatedAt: now(),
    };
    jobs.set(failed.id, failed);
    if (input.autoRunId) {
      const key = `${input.autoRunId}:${blocked}`;
      if (!postedBlockHints.has(key)) {
        postedBlockHints.add(key);
        appendRunMessage(input.autoRunId, 'system', blocked);
      }
    }
    return failed;
  }

  const job: RunnerJob = {
    id: uuidv4(),
    projectId: input.projectId,
    taskId,
    autoRunId: input.autoRunId ?? null,
    chatSessionId: input.chatSessionId ?? null,
    kind,
    studioKind: input.studioKind,
    prompt: input.prompt,
    cwd: input.cwd,
    status: 'queued',
    agentName: runnerProviderAgentName(provider),
    provider,
    createdAt: now(),
    updatedAt: now(),
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  void pump();
  return job;
}

export function getRunnerJob(jobId: string): RunnerJob | undefined {
  return jobs.get(jobId);
}

export function cancelForAutoRun(autoRunId: string) {
  for (const job of jobs.values()) {
    if (job.autoRunId !== autoRunId) continue;
    if (job.status === 'queued') {
      touch(job, { status: 'cancelled', error: 'Auto Run 已停止' });
      const idx = queue.indexOf(job.id);
      if (idx >= 0) queue.splice(idx, 1);
    } else if (job.status === 'claiming' || job.status === 'running') {
      controllers.get(job.id)?.abort();
      touch(job, { status: 'cancelled', error: 'Auto Run 已停止' });
    }
  }
}

async function pump() {
  const limit = getRunnerConcurrency();
  while (activeCount < limit && queue.length > 0) {
    const jobId = queue.shift();
    if (!jobId) break;
    const job = jobs.get(jobId);
    if (!job || job.status !== 'queued') continue;
    activeCount += 1;
    void runJob(jobId).finally(() => {
      activeCount -= 1;
      void pump();
    });
  }
}

async function runJob(jobId: string) {
  let job = jobs.get(jobId);
  if (!job) return;

  if (job.kind === 'studio') {
    await runStudioJob(jobId);
    return;
  }
  if (job.kind === 'chat') {
    await runChatJob(jobId);
    return;
  }

  const provider = job.provider ?? resolveRunnerProvider(job.projectId);
  const controller = new AbortController();
  controllers.set(jobId, controller);

  let leaseToken: string | null = null;
  let agentName = runnerProviderAgentName(provider);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  try {
    job = touch(job, { status: 'claiming', provider });
    appendRunnerLog(job.projectId, job.taskId, 'system', 'Runner 正在認領任務…');
    const task = getTask(job.projectId, job.taskId);
    agentName = String(task.assignee_name || task.assignee_agent_id || agentName);

    let staffPrompt = '';
    if (task.assignee_agent_id) {
      try {
        const staff = getStaffAgent(String(task.assignee_agent_id));
        staffPrompt = staff.system_prompt;
        agentName = staff.name;
      } catch {
        /* optional */
      }
    }

    if (task.status === 'todo') {
      const claimed = claimTask(job.projectId, job.taskId, agentName, task.version);
      leaseToken = String((claimed as { lease_token?: string }).lease_token ?? '');
    } else if (task.status === 'in_progress' && task.lease?.leaseToken) {
      leaseToken = task.lease.leaseToken;
      agentName = task.lease.agentName || agentName;
    } else if (task.status === 'done') {
      touch(job, { status: 'completed', resultSummary: '任務已是 done，跳過 Runner' });
      return;
    } else {
      throw new Error(`任務狀態 ${task.status} 無法由 Runner 執行`);
    }

    job = touch(job, { status: 'running', agentName });

    const onLog = (kind: 'system' | 'assistant' | 'tool' | 'thinking' | 'error', text: string) => {
      if (kind === 'assistant' || kind === 'thinking') {
        updateOrAppendRunnerLog(job!.projectId, job!.taskId, kind, text);
      } else {
        appendRunnerLog(job!.projectId, job!.taskId, kind, text);
      }
    };

    if (leaseToken) {
      heartbeatTimer = setInterval(() => {
        try {
          if (leaseToken) heartbeatTask(job!.projectId, job!.taskId, agentName, leaseToken);
        } catch {
          /* ignore heartbeat errors */
        }
      }, 5 * 60 * 1000);
    }

    const refreshed = getTask(job.projectId, job.taskId);
    const cwd = String(refreshed.execution_path || refreshed.workspacePath || refreshed.workspace_path);
    const prompt = buildRunnerPrompt({
      staffName: agentName,
      systemPrompt: staffPrompt,
      taskId: refreshed.id,
      title: refreshed.title,
      goal: String(refreshed.goal ?? ''),
      acceptanceCriteria: String(refreshed.acceptance_criteria ?? ''),
      constraints: String(refreshed.constraints ?? ''),
      executionPath: cwd,
    });

    const label = runnerProviderLabel(provider);
    appendRunnerLog(
      job.projectId,
      job.taskId,
      'system',
      `${label} 開始執行 @ ${cwd}（Agent：${agentName}）`,
    );
    if (job.autoRunId) {
      appendRunMessage(job.autoRunId, 'system', `${label} 開始執行 ${job.taskId} @ ${cwd}`);
      appendRunEvent(
        job.autoRunId,
        'runner_started',
        'runner',
        `${label} 開始 ${job.taskId}`,
        {
          taskId: job.taskId,
          data: { provider, agentName, cwd, jobId: job.id },
        },
      );
    }

    let outcome = await runPromptForProvider(provider, {
      prompt,
      cwd,
      taskId: job.taskId,
      name: `pm-ai-${job.taskId}`,
      signal: controller.signal,
      onLog,
    });

    for (let attempt = 1; attempt < RUNNER_PROMPT_MAX_ATTEMPTS; attempt++) {
      if (outcome.ok || outcome.status === 'cancelled' || controller.signal.aborted) break;
      const retryable = isRetryableConnectionError(outcome.error ?? outcome.status);
      if (!retryable) break;
      if (job.autoRunId) {
        appendRunMessage(
          job.autoRunId,
          'system',
          `Runner 連線失敗（${outcome.error ?? outcome.status}），${attempt + 1}/${RUNNER_PROMPT_MAX_ATTEMPTS} 次重試…`,
        );
        appendRunEvent(
          job.autoRunId,
          'runner_retry',
          'runner',
          `Runner 重試 ${job.taskId}（${attempt + 1}/${RUNNER_PROMPT_MAX_ATTEMPTS}）`,
          {
            taskId: job.taskId,
            data: { error: outcome.error ?? outcome.status, attempt: attempt + 1 },
          },
        );
      }
      await sleep(400 * attempt);
      if (controller.signal.aborted) break;
      outcome = await runPromptForProvider(provider, {
        prompt,
        cwd,
        taskId: job.taskId,
        name: `pm-ai-${job.taskId}`,
        signal: controller.signal,
        onLog,
      });
    }

    job = touch(job, { sdkRunId: outcome.runId ?? null });

    if (!leaseToken) {
      throw new Error('缺少 lease_token，無法 complete');
    }

    if (outcome.ok) {
      const summary = (outcome.resultText ?? `${label} 執行完成`).slice(0, 4000);
      appendRunnerLog(job.projectId, job.taskId, 'system', `✓ 任務完成（${outcome.durationMs ?? 0}ms）`);
      completeTask(job.projectId, job.taskId, agentName, leaseToken, summary, [
        `${provider}_run:${outcome.runId ?? 'ok'}`,
      ]);
      leaseToken = null;
      touch(job, {
        status: 'completed',
        resultSummary: summary,
      });
      if (job.autoRunId) {
        appendRunMessage(job.autoRunId, 'assistant', `任務 ${job.taskId} 已由 ${label} 完成。`);
        appendRunEvent(
          job.autoRunId,
          'runner_completed',
          'runner',
          `${label} 完成 ${job.taskId}`,
          {
            taskId: job.taskId,
            data: { provider, jobId: job.id, durationMs: outcome.durationMs ?? null },
          },
        );
      }
      notifyRunnerTaskEvent(job.projectId, job.taskId, 'runner_completed');
    } else if (outcome.status === 'cancelled' || controller.signal.aborted) {
      appendRunnerLog(job.projectId, job.taskId, 'system', 'Runner 已取消');
      try {
        releaseTask(job.projectId, job.taskId, agentName, leaseToken, 'Runner 已取消');
      } catch {
        /* ignore */
      }
      leaseToken = null;
      touch(job, { status: 'cancelled', error: outcome.error ?? '已取消' });
    } else {
      appendRunnerLog(
        job.projectId,
        job.taskId,
        'error',
        `Runner 失敗：${outcome.error ?? outcome.status}`,
      );
      try {
        progressTask(
          job.projectId,
          job.taskId,
          agentName,
          leaseToken,
          `Runner 失敗：${outcome.error ?? outcome.status}`,
        );
        releaseTask(
          job.projectId,
          job.taskId,
          agentName,
          leaseToken,
          outcome.error ?? `${label} 執行失敗`,
        );
      } catch {
        /* ignore */
      }
      leaseToken = null;
      touch(job, {
        status: 'failed',
        error: outcome.error ?? `狀態 ${outcome.status}`,
      });
      if (job.autoRunId) {
        appendRunMessage(
          job.autoRunId,
          'system',
          `任務 ${job.taskId} Runner 失敗：${outcome.error ?? outcome.status}`,
        );
        appendRunEvent(
          job.autoRunId,
          'runner_failed',
          'runner',
          `Runner 失敗 ${job.taskId}`,
          {
            taskId: job.taskId,
            data: { error: outcome.error ?? outcome.status, jobId: job.id },
          },
        );
      }
      notifyRunnerTaskEvent(job.projectId, job.taskId, 'runner_failed');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunnerLog(job.projectId, job.taskId, 'error', `Runner 異常：${message}`);
    if (leaseToken) {
      try {
        releaseTask(job.projectId, job.taskId, agentName, leaseToken, message);
      } catch {
        /* ignore */
      }
    }
    touch(job, { status: 'failed', error: message });
    if (job.autoRunId) {
      appendRunMessage(job.autoRunId, 'system', `任務 ${job.taskId} Runner 異常：${message}`);
      appendRunEvent(job.autoRunId, 'runner_failed', 'runner', `Runner 異常 ${job.taskId}`, {
        taskId: job.taskId,
        data: { error: message, jobId: job.id },
      });
    }
    notifyRunnerTaskEvent(job.projectId, job.taskId, 'runner_failed');
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    controllers.delete(jobId);
  }
}

async function runStudioJob(jobId: string) {
  let job = jobs.get(jobId);
  if (!job) return;

  const provider = job.provider ?? resolveRunnerProvider(job.projectId);
  const controller = new AbortController();
  controllers.set(jobId, controller);
  const agentName = runnerProviderAgentName(provider);
  const cwd = job.cwd;
  const prompt = job.prompt;

  try {
    if (!cwd || !prompt) {
      throw new Error('Studio job 缺少 cwd 或 prompt');
    }

    job = touch(job, { status: 'running', provider, agentName });
    const label = runnerProviderLabel(provider);
    const name =
      job.studioKind === 'design'
        ? `pm-ai-design-${job.projectId.slice(0, 8)}`
        : `pm-ai-req-${job.projectId.slice(0, 8)}`;

    const outcome = await runPromptForProvider(provider, {
      prompt,
      cwd,
      taskId: job.studioKind ?? 'studio',
      name,
      signal: controller.signal,
    });

    job = touch(job, { sdkRunId: outcome.runId ?? null });

    if (outcome.ok) {
      const summary = (outcome.resultText ?? `${label} 已完成`).slice(0, 4000);
      const done = touch(job, { status: 'completed', resultSummary: summary });
      await notifyStudioJobFinished(done);
    } else if (outcome.status === 'cancelled' || controller.signal.aborted) {
      touch(job, { status: 'cancelled', error: outcome.error ?? '已取消' });
    } else {
      const failed = touch(job, {
        status: 'failed',
        error: outcome.error ?? `狀態 ${outcome.status}`,
      });
      await notifyStudioJobFinished(failed);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = touch(job, { status: 'failed', error: message });
    await notifyStudioJobFinished(failed);
  } finally {
    controllers.delete(jobId);
  }
}

async function notifyStudioJobFinished(job: RunnerJob) {
  try {
    const { recordStudioOutcome } = await import('../services/studio-ai.js');
    recordStudioOutcome(job);
  } catch {
    /* optional */
  }
}

async function runChatJob(jobId: string) {
  let job = jobs.get(jobId);
  if (!job) return;

  const provider = job.provider ?? resolveRunnerProvider(job.projectId);
  const controller = new AbortController();
  controllers.set(jobId, controller);
  const agentName = runnerProviderAgentName(provider);
  const cwd = job.cwd;
  const prompt = job.prompt;
  const sessionId = job.chatSessionId;

  const onLog = (kind: import('./logs.js').RunnerLogKind, text: string) => {
    if (!sessionId) return;
    void import('../services/chat-stream.js').then((m) => {
      if (kind === 'assistant' || kind === 'thinking') {
        m.updateOrAppendChatStream(sessionId, kind, text);
      } else {
        m.appendChatStream(sessionId, kind === 'error' ? 'error' : kind === 'tool' ? 'tool' : 'system', text);
      }
    });
  };

  try {
    if (!cwd || !prompt || !sessionId) {
      throw new Error('Chat job 缺少 cwd、prompt 或 chatSessionId');
    }

    job = touch(job, { status: 'running', provider, agentName });
    onLog('system', `${runnerProviderLabel(provider)} 開始執行…`);

    const outcome = await runPromptForProvider(provider, {
      prompt,
      cwd,
      taskId: job.taskId || `chat-${sessionId.slice(0, 8)}`,
      name: `pm-ai-chat-${sessionId.slice(0, 8)}`,
      chatSessionId: sessionId,
      signal: controller.signal,
      onLog,
      onAskUser: async (question, options) => {
        const { notifyChatAwaitingUser } = await import('../services/chat.js');
        await notifyChatAwaitingUser(sessionId, question, options);
      },
    });

    job = touch(job, { sdkRunId: outcome.runId ?? null });

    if (outcome.ok) {
      const summary = (outcome.resultText ?? 'Agent 已完成').slice(0, 8000);
      const done = touch(job, { status: 'completed', resultSummary: summary });
      await notifyChatJobFinished(done);
    } else if (outcome.status === 'cancelled' || controller.signal.aborted) {
      const cancelled = touch(job, { status: 'cancelled', error: outcome.error ?? '已取消' });
      await notifyChatJobFinished(cancelled);
    } else {
      const failed = touch(job, {
        status: 'failed',
        error: outcome.error ?? `狀態 ${outcome.status}`,
      });
      await notifyChatJobFinished(failed);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = touch(job, { status: 'failed', error: message });
    await notifyChatJobFinished(failed);
  } finally {
    controllers.delete(jobId);
  }
}

async function notifyChatJobFinished(job: RunnerJob) {
  try {
    const { recordChatJobFinished } = await import('../services/chat.js');
    recordChatJobFinished(job);
  } catch {
    /* optional */
  }
}

export type { RunnerJob, RunnerJobStatus };
