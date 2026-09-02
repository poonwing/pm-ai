import { appendRunMessage, updateAutoRun } from '../../services/auto.js';
import { getInbox, listProjectTasks } from '../../services/tasks.js';
import { isPendingReview } from '../../../shared/schemas.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';

export async function synthesizeNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const projectId = state.projectId;
  const runId = state.runId;
  const tasks = listProjectTasks(projectId);
  const inbox = getInbox().filter((t) => t.projectId === projectId || t.project_id === projectId);
  const done = tasks.filter((t) => t.status === 'done');
  const pendingReview = done.filter((t) =>
    isPendingReview(t as Parameters<typeof isPendingReview>[0]),
  );
  const pendingAi = pendingReview.filter(
    (t) => t.review?.reviewer_type === 'agent' || t.review?.reviewer_type === 'orchestrator',
  );
  const pendingHuman = pendingReview.filter(
    (t) => !t.review || t.review.reviewer_type === 'human',
  );
  const summary = `進度：共 ${tasks.length} 任務，完成 ${done.length}，待 AI 復查 ${pendingAi.length}，待人驗收 ${pendingHuman.length}，inbox ${inbox.length}`;
  appendRunMessage(runId, 'assistant', summary);

  if (tasks.length && done.length === tasks.length && pendingReview.length === 0) {
    const next = { ...state, status: 'completed', phase: 'completed' };
    syncRunMirror(next);
    updateAutoRun(runId, { status: 'completed', phase: 'completed' });
    return { status: 'completed', phase: 'completed' };
  }

  const next = { ...state, phase: 'synthesize', status: 'running' };
  syncRunMirror(next);
  return { phase: 'synthesize', status: 'running' };
}

export function routeAfterSynthesize(state: OrchestratorStateType): string {
  if (state.status === 'completed' || state.phase === 'completed') return 'endDone';
  return 'waitEvents';
}
