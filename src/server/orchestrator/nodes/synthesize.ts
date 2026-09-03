import { appendRunMessage, updateAutoRun } from '../../services/auto.js';
import { getInbox } from '../../services/tasks.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';
import { evaluateRunProgress } from '../helpers.js';
import { appendRunEvent } from '../../services/run-events.js';

export async function synthesizeNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const projectId = state.projectId;
  const runId = state.runId;
  const progress = evaluateRunProgress(projectId, runId);
  const inbox = getInbox().filter((t) => t.projectId === projectId || t.project_id === projectId);

  const summary = `${progress.summary}，inbox ${inbox.length}`;
  appendRunMessage(runId, 'assistant', summary);

  if (progress.canComplete) {
    const reason =
      progress.tasks.length === 0
        ? '沒有待辦任務，結束 Auto Run'
        : progress.cancelled.length && !progress.done.length
          ? `本 Run 任務均已取消（${progress.cancelled.length}），結束 Auto Run`
          : progress.cancelled.length
            ? `本 Run 任務均已結束（完成 ${progress.done.length}、取消 ${progress.cancelled.length}），結束 Auto Run`
            : `本 Run 任務均已完成並通過審查（${progress.done.length}），結束 Auto Run`;
    appendRunMessage(runId, 'assistant', reason);
    appendRunEvent(runId, 'status_changed', 'system', reason, {
      data: {
        canComplete: true,
        done: progress.done.length,
        cancelled: progress.cancelled.length,
        scopedToRun: progress.scopedToRun,
      },
    });
    const next = { ...state, status: 'completed', phase: 'completed' };
    syncRunMirror(next);
    updateAutoRun(runId, { status: 'completed', phase: 'completed' });
    return { status: 'completed', phase: 'completed' };
  }

  if (progress.open.length === 0 && progress.pendingHuman.length > 0) {
    appendRunMessage(
      runId,
      'assistant',
      `實作已結束，尚有 ${progress.pendingHuman.length} 個任務待你驗收：${progress.pendingHuman.map((t) => t.id).join(', ')}`,
    );
  } else if (progress.open.length === 0 && progress.pendingAi.length > 0) {
    appendRunMessage(
      runId,
      'assistant',
      `實作已結束，尚有 ${progress.pendingAi.length} 個任務待 AI 復查。`,
    );
  } else if (progress.open.length) {
    appendRunMessage(
      runId,
      'system',
      `尚未結束的任務：${progress.open.map((t) => `${t.id}(${t.status})`).join(', ')}`,
    );
  }

  const next = { ...state, phase: 'synthesize', status: 'running' };
  syncRunMirror(next);
  return { phase: 'synthesize', status: 'running' };
}

export function routeAfterSynthesize(state: OrchestratorStateType): string {
  if (state.status === 'completed' || state.phase === 'completed') return 'endDone';
  return 'waitEvents';
}
