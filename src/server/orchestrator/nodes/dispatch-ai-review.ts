import { appendRunMessage } from '../../services/auto.js';
import { dispatchPendingAiReviews } from '../ai-review.js';
import type { OrchestratorStateType } from '../state.js';

export async function dispatchAiReviewNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const started = dispatchPendingAiReviews(state.projectId, state.runId);
  if (started.length) {
    appendRunMessage(state.runId, 'system', `已啟動 AI 復查：${started.join(', ')}`);
  }
  return { phase: 'synthesize' };
}
