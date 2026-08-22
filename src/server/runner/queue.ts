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
import { buildRunnerPrompt } from './prompt.js';
import {
  getRunnerConcurrency,
  getRunnerProvider,
  isRunnerConfigured,
  type RunnerJob,
  type RunnerJobStatus,
  type RunnerProvider,
} from './types.js';

const jobs = new Map<string, RunnerJob>();
const queue: string[] = [];
const controllers = new Map<string, AbortController>();
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

function missingKeyMessage(provider: RunnerProvider): string {
  return provider === 'opencode'
    ? '未配置 ZAI_API_KEY（OpenCode 复用 GLM Coding Plan Key）'
    : '未配置 CURSOR_API_KEY，無法啟動 Cursor SDK Runner';
}

export function getRunnerStatus(projectId: string) {
  const provider = getRunnerProvider();
  return {
    provider,
    configured: isRunnerConfigured(provider),
    concurrency: getRunnerConcurrency(),
    jobs: listJobsForProject(projectId),
  };
}

export function enqueueRunnerJob(input: {
  projectId: string;
  taskId: string;
  autoRunId?: string | null;
}): RunnerJob {
  const provider = getRunnerProvider();
  const existing = [...jobs.values()].find(
    (j) =>
      j.projectId === input.projectId &&
      j.taskId === input.taskId &&
      (j.status === 'queued' || j.status === 'claiming' || j.status === 'running'),
  );
  if (existing) return existing;

  if (!isRunnerConfigured(provider)) {
    const failed: RunnerJob = {
      id: uuidv4(),
      projectId: input.projectId,
      taskId: input.taskId,
      autoRunId: input.autoRunId ?? null,
      status: 'failed',
      agentName: provider,
      provider,
      error: missingKeyMessage(provider),
      createdAt: now(),
      updatedAt: now(),
    };
    jobs.set(failed.id, failed);
    if (input.autoRunId) {
      appendRunMessage(
        input.autoRunId,
        'system',
        `任務 ${input.taskId} Runner 失敗：${missingKeyMessage(provider)}`,
      );
    }
    return failed;
  }

  const job: RunnerJob = {
    id: uuidv4(),
    projectId: input.projectId,
    taskId: input.taskId,
    autoRunId: input.autoRunId ?? null,
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

  const provider = job.provider ?? getRunnerProvider();
  const controller = new AbortController();
  controllers.set(jobId, controller);

  let leaseToken: string | null = null;
  let agentName = provider === 'opencode' ? 'opencode' : 'cursor-sdk';
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  try {
    job = touch(job, { status: 'claiming', provider });
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
    if (job.autoRunId) {
      appendRunMessage(job.autoRunId, 'system', `${label} 開始執行 ${job.taskId} @ ${cwd}`);
    }

    const outcome =
      provider === 'opencode'
        ? await runOpenCodePrompt({
            prompt,
            cwd,
            taskId: job.taskId,
            signal: controller.signal,
          })
        : await runCursorSdkPrompt({
            prompt,
            cwd,
            name: `pm-ai-${job.taskId}`,
            signal: controller.signal,
          });

    job = touch(job, { sdkRunId: outcome.runId ?? null });

    if (!leaseToken) {
      throw new Error('缺少 lease_token，無法 complete');
    }

    if (outcome.ok) {
      const summary = (outcome.resultText ?? `${label} 執行完成`).slice(0, 4000);
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
    } else if (outcome.status === 'cancelled' || controller.signal.aborted) {
      try {
        releaseTask(job.projectId, job.taskId, agentName, leaseToken, 'Runner 已取消');
      } catch {
        /* ignore */
      }
      leaseToken = null;
      touch(job, { status: 'cancelled', error: outcome.error ?? '已取消' });
    } else {
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
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    controllers.delete(jobId);
  }
}

export type { RunnerJob, RunnerJobStatus };
