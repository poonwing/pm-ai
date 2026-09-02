import { v4 as uuidv4 } from 'uuid';
import { appendRunMessage, createDecision, listDecisions } from '../../services/auto.js';
import { interrupt } from '@langchain/langgraph';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';

export async function decisionGateNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const plan = state.plan;
  if (!plan?.need_decision || !plan.decision) return {};

  const existing = listDecisions(state.projectId, 'open').filter((d) => d.run_id === state.runId);
  if (!existing.length) {
    createDecision({
      projectId: state.projectId,
      runId: state.runId,
      title: plan.decision.title,
      summary: plan.decision.summary,
      options: plan.decision.options.map((o) => ({
        id: o.id || uuidv4(),
        label: o.label,
        description: o.description,
      })),
      recommendedOptionId: plan.decision.recommended_option_id ?? null,
    });
    appendRunMessage(state.runId, 'assistant', `需要你決策：${plan.decision.title}`);
  }

  const next = { ...state, status: 'awaiting_human', phase: 'decision' };
  syncRunMirror(next);
  interrupt({ reason: 'plan_decision' });
  return { status: 'awaiting_human', phase: 'decision' };
}

export function routeAfterDecisionGate(state: OrchestratorStateType): string {
  const open = listDecisions(state.projectId, 'open').filter((d) => d.run_id === state.runId);
  if (open.length) return 'endAwaiting';
  return 'ensureStaff';
}
