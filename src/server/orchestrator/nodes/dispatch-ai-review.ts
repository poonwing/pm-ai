import { appendRunMessage } from '../../services/auto.js';
import { appendRunEvent } from '../../services/run-events.js';
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
    appendRunEvent(state.runId, 'ai_review_dispatch', 'ai_review', summary, {
      data: {
        started: result.started,
        skippedInFlight: result.skippedInFlight,
        skippedCooldown: result.skippedCooldown,
        pending: result.pending,
        modelMissing: result.modelMissing,
      },
    });
  }
  return { phase: 'synthesize' };
}
