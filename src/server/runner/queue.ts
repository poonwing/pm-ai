import { v4 as uuidv4 } from 'uuid';
import { getStaffAgent } from '../services/agents.js';
import {
  claimTask,
  completeTask,
  getTask,
  heartbeatTask,
  progressTask,
  releaseTask,
} from '../services/tasks.js';
import { appendRunMessage } from '../services/auto.js';
import { runCursorSdkPrompt } from './cursor-sdk-runner.js';
import { runOpenCodePrompt } from './opencode-runner.js';
import { isOpenCodeCliInstalled, OPENCODE_CLI_INSTALL_HINT } from './opencode-cli.js';
import { buildRunnerPrompt } from './prompt.js';
import { isRetryableConnectionError } from '../orchestrator/model.js';
import { appendRunnerLog, updateOrAppendRunnerLog } from './logs.js';
import {
  getRunnerConcurrency,
  getRunnerProvider,
  isCursorRunnerConfigured,
  isOpenCodeRunnerConfigured,
  type RunnerJob,
  type RunnerJobStatus,
  type RunnerProvider,
  type RunnerJobKind,
  type StudioKind,
} from './types.js';

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
  return provider === 'opencode'
    ? '未配置 ZAI_API_KEY（OpenCode 复用 GLM Coding Plan Key）'
    : '未配置 CURSOR_API_KEY，無法啟動 Cursor SDK Runner';
}

function runnerBlockReason(provider: RunnerProvider): string | null {
  if (provider === 'opencode') {
    if (!isOpenCodeRunnerConfigured()) return missingKeyMessage(provider);
    if (!isOpenCodeCliInstalled()) return OPENCODE_CLI_INSTALL_HINT;
    return null;
  }
  if (!isCursorRunnerConfigured()) return missingKeyMessage(provider);
  return null;
}

export function getRunnerStatus(projectId: string) {
  const provider = getRunnerProvider();
  const hint = runnerBlockReason(provider);
  return {
    provider,
    configured: provider === 'opencode' ? isOpenCodeRunnerConfigured() : isCursorRunnerConfigured(),
    cliInstalled: provider !== 'opencode' || isOpenCodeCliInstalled(),
    ready: hint === null,
    hint,
    concurrency: getRunnerConcurrency(),
    jobs: listJobsForProject(projectId),
  };
}

export function enqueueRunnerJob(input: {
  projectId: string;
  taskId?: string;
  autoRunId?: string | null;
  kind?: RunnerJobKind;
  studioKind?: StudioKind;
  prompt?: string;
  cwd?: string;
}): RunnerJob {
  const provider = getRunnerProvider();
  const kind: RunnerJobKind = input.kind ?? 'task';
  const taskId = input.taskId ?? '';

  if (kind === 'task' && taskId) {
    const existing = [...jobs.values()].find(
      (j) =>
        j.projectId === input.projectId &&
        j.taskId === taskId &&
        j.kind !== 'studio' &&
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

  const blocked = runnerBlockReason(provider);
  if (blocked) {
    const failed: RunnerJob = {
      id: uuidv4(),
      projectId: input.projectId,
      taskId,
      autoRunId: input.autoRunId ?? null,
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
    kind,
    studioKind: input.studioKind,
    prompt: input.prompt,
    cwd: input.cwd,
    status: 'queued',
    agentName: provider === 'opencode' ? 'opencode' : 'cursor-sdk',
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

  const provider = job.provider ?? getRunnerProvider();
  const controller = new AbortController();
  controllers.set(jobId, controller);

  let leaseToken: string | null = null;
  let agentName = provider === 'opencode' ? 'opencode' : 'cursor-sdk';
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

    const label = provider === 'opencode' ? 'OpenCode' : 'Cursor SDK';
    appendRunnerLog(
      job.projectId,
      job.taskId,
      'system',
      `${label} 開始執行 @ ${cwd}（Agent：${agentName}）`,
    );
    if (job.autoRunId) {
      appendRunMessage(job.autoRunId, 'system', `${label} 開始執行 ${job.taskId} @ ${cwd}`);
    }

    let outcome =
      provider === 'opencode'
        ? await runOpenCodePrompt({
            prompt,
            cwd,
            taskId: job.taskId,
            signal: controller.signal,
            onLog,
          })
        : await runCursorSdkPrompt({
            prompt,
            cwd,
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
      }
      await sleep(400 * attempt);
      if (controller.signal.aborted) break;
      outcome =
        provider === 'opencode'
          ? await runOpenCodePrompt({
              prompt,
              cwd,
              taskId: job.taskId,
              signal: controller.signal,
              onLog,
            })
          : await runCursorSdkPrompt({
              prompt,
              cwd,
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

  const provider = job.provider ?? getRunnerProvider();
  const controller = new AbortController();
  controllers.set(jobId, controller);
  const agentName = provider === 'opencode' ? 'opencode' : 'cursor-sdk';
  const cwd = job.cwd;
  const prompt = job.prompt;

  try {
    if (!cwd || !prompt) {
      throw new Error('Studio job 缺少 cwd 或 prompt');
    }

    job = touch(job, { status: 'running', provider, agentName });
    const label = provider === 'opencode' ? 'OpenCode' : 'Cursor SDK';
    const name =
      job.studioKind === 'design'
        ? `pm-ai-design-${job.projectId.slice(0, 8)}`
        : `pm-ai-req-${job.projectId.slice(0, 8)}`;

    const outcome =
      provider === 'opencode'
        ? await runOpenCodePrompt({
            prompt,
            cwd,
            taskId: job.studioKind ?? 'studio',
            signal: controller.signal,
          })
        : await runCursorSdkPrompt({
            prompt,
            cwd,
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

export type { RunnerJob, RunnerJobStatus };
