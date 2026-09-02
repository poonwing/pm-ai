import { interrupt } from '@langchain/langgraph';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';

export async function waitEventsNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  if (state.forceReplan) {
    return { forceReplan: true, phase: 'plan', status: 'running' };
  }

  if (state.status === 'completed' || state.phase === 'completed') {
    return {};
  }

  const next = { ...state, phase: 'wait_events', status: 'running' };
  syncRunMirror(next);
  interrupt({ reason: 'wait_events' });
  return { phase: 'wait_events', status: 'running' };
}

export function routeAfterWait(state: OrchestratorStateType): string {
  if (state.forceReplan) return 'planning';
  if (state.status === 'completed' || state.phase === 'completed') return 'endDone';
  return 'reconcileRunner';
}
