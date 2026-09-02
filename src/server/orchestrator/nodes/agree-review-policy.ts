import {
  appendRunMessage,
  createDecision,
  getReviewPolicy,
  listDecisions,
  upsertReviewPolicy,
} from '../../services/auto.js';
import { interrupt } from '@langchain/langgraph';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';

export async function agreeReviewPolicyNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  if (getReviewPolicy(state.projectId).confirmed) {
    if (state.phase === 'agree_review_policy') {
      return { phase: 'plan', status: 'running' };
    }
    return {};
  }

  const draft = upsertReviewPolicy(
    state.projectId,
    {
      default_reviewer_type: 'human',
      human_verify_notes: `針對目標「${state.goal}」：核心交付需人類驗收；細節可由 AI reviewer 先查。`,
      confirmed: false,
    },
    false,
  );

  appendRunMessage(
    state.runId,
    'assistant',
    `請先確認審查協定（Review Policy）：預設審查者=${draft.default_reviewer_type}。確認後我會繼續規劃與分派。`,
  );

  createDecision({
    projectId: state.projectId,
    runId: state.runId,
    title: '確認 Review Policy',
    summary: draft.human_verify_notes,
    options: [
      { id: 'confirm', label: '確認預設協定並繼續' },
      {
        id: 'agent_default',
        label: '預設由 AI agent 審查',
        description: 'default_reviewer_type=agent',
      },
      {
        id: 'human_only',
        label: '全部由人類驗收',
        description: 'default_reviewer_type=human',
      },
    ],
    recommendedOptionId: 'confirm',
  });

  const checkpoint = { ...state.checkpoint, clarified: true, policy_draft: draft };
  const next = {
    ...state,
    status: 'awaiting_human',
    phase: 'agree_review_policy',
    checkpoint,
  };
  syncRunMirror(next);
  interrupt({ reason: 'agree_review_policy' });
  return { status: 'awaiting_human', phase: 'agree_review_policy', checkpoint };
}

export function routeAfterPolicy(state: OrchestratorStateType): string {
  const open = listDecisions(state.projectId, 'open').filter((d) => d.run_id === state.runId);
  if (open.some((d) => d.title.includes('Review Policy'))) return 'endAwaiting';
  return 'planning';
}
