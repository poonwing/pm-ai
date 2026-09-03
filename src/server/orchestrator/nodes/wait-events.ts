import { interrupt } from '@langchain/langgraph';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';
import { appendRunEvent } from '../../services/run-events.js';

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
  appendRunEvent(state.runId, 'interrupt', 'graph', '圖中斷於 waitEvents（等待 Runner / 人工 / 推進）', {
    data: { reason: 'wait_events', phase: 'wait_events' },
  });
  interrupt({ reason: 'wait_events' });
  return { phase: 'wait_events', status: 'running' };
}

export function routeAfterWait(state: OrchestratorStateType): string {
  if (state.forceReplan) return 'planning';
  if (state.status === 'completed' || state.phase === 'completed') return 'endDone';
  return 'reconcileRunner';
}
