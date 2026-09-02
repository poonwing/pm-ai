import {
  appendRunMessage,
  getAutoRun,
  updateAutoRun,
} from '../../services/auto.js';
import { getTask } from '../../services/tasks.js';
import { getRunnerStatus } from '../../runner/index.js';
import { isRetryableConnectionError } from '../model.js';
import type { OrchestratorStateType } from '../state.js';
import {
  collectRunTaskIds,
  hasActiveRunnerJob,
  latestRunnerJob,
  prepareTaskForRunnerRetry,
  runnerRetryCountsFromCheckpoint,
  runnerStallNotifiedFromCheckpoint,
  RUNNER_ORCH_MAX_RETRIES,
} from '../helpers.js';

export async function reconcileRunnerFailures(
  runId: string,
  opts?: { force?: boolean },
): Promise<string[]> {
  const run = getAutoRun(runId);
  const taskIds = collectRunTaskIds(run, { includeAllPending: opts?.force });
  if (!taskIds.length) return [];

  const allJobs = getRunnerStatus(run.project_id).jobs;
  const retryCounts = { ...runnerRetryCountsFromCheckpoint(run.checkpoint) };
  const stallNotified = [...runnerStallNotifiedFromCheckpoint(run.checkpoint)];
  const requeued: string[] = [];
  let checkpointPatch: Record<string, unknown> | null = null;

  for (const taskId of taskIds) {
    let task;
    try {
      task = getTask(run.project_id, taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendRunMessage(runId, 'system', `重試跳過 ${taskId}：${msg}`);
      continue;
    }
    if (task.status === 'done' || task.status === 'cancelled') continue;
    if (hasActiveRunnerJob(allJobs, taskId)) continue;

    if (opts?.force) {
      task = prepareTaskForRunnerRetry(run.project_id, taskId);
      if (task.status !== 'todo' && task.status !== 'in_progress') continue;
      if (task.status === 'in_progress' && !(task as { lease?: { leaseToken?: string } }).lease?.leaseToken) continue;

      const { enqueueRunnerJob } = await import('../../runner/index.js');
      const job = enqueueRunnerJob({
        projectId: run.project_id,
        taskId,
        autoRunId: runId,
      });
      if (job.status !== 'failed') requeued.push(taskId);
      continue;
    }

    task = prepareTaskForRunnerRetry(run.project_id, taskId);
    if (task.status !== 'todo') continue;

    const terminal = latestRunnerJob(allJobs, taskId);
    const err = terminal?.error ?? '';
    const shouldRetryWithoutJob =
      !terminal || terminal.status === 'failed' || terminal.status === 'cancelled';
    if (!shouldRetryWithoutJob) continue;

    const retryable = isRetryableConnectionError(err) || !terminal || terminal.status === 'cancelled';
    if (!retryable) {
      if (!stallNotified.includes(taskId)) {
        stallNotified.push(taskId);
        appendRunMessage(
          runId,
          'assistant',
          `任務 ${taskId} Runner 失敗且無法自動重試：${err}。請修正配置或網路後回覆「重試」，或點「推進一步」。`,
        );
        checkpointPatch = { runner_stall_notified: stallNotified };
      }
      continue;
    }

    const count = retryCounts[taskId] ?? 0;
    if (count >= RUNNER_ORCH_MAX_RETRIES) {
      if (!stallNotified.includes(taskId)) {
        stallNotified.push(taskId);
        appendRunMessage(
          runId,
          'assistant',
          `任務 ${taskId} Runner 已重試 ${RUNNER_ORCH_MAX_RETRIES} 次仍失敗（${err}）。請檢查 CURSOR_API_KEY / 網路，修好後回覆「重試」。`,
        );
        checkpointPatch = { runner_stall_notified: stallNotified };
      }
      continue;
    }

    const { enqueueRunnerJob } = await import('../../runner/index.js');
    const job = enqueueRunnerJob({
      projectId: run.project_id,
      taskId,
      autoRunId: runId,
    });
    if (job.status === 'failed') continue;
    retryCounts[taskId] = count + 1;
    requeued.push(taskId);
  }

  if (requeued.length || checkpointPatch) {
    updateAutoRun(runId, {
      checkpoint: {
        ...run.checkpoint,
        ...(requeued.length ? { runner_retry_counts: retryCounts } : {}),
        ...(checkpointPatch ?? {}),
      },
    });
    appendRunMessage(runId, 'system', `已重新提交 Runner：${requeued.join(', ')}`);
  }

  return requeued;
}

export async function reconcileRunnerNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const force = state.pendingCommand?.type === 'retry_runner';
  await reconcileRunnerFailures(state.runId, { force });
  return { pendingCommand: null };
}
