import { appendRunMessage } from '../../services/auto.js';
import {
  dispatchPendingAiReviews,
  formatDispatchAiReviewsResult,
} from '../ai-review.js';
import type { OrchestratorStateType } from '../state.js';

export async function dispatchAiReviewNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const result = dispatchPendingAiReviews(state.projectId, state.runId);
  const summary = formatDispatchAiReviewsResult(result);
  if (summary) {
    appendRunMessage(state.runId, 'system', summary);
  }
  return { phase: 'synthesize' };
}
