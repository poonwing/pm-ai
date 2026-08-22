/**
 * LangGraph-compatible phase graph for the Auto orchestrator.
 * Human interrupts (Decision Gate) are handled outside via awaiting_human + resolve APIs;
 * this module documents/exports the phase edges used by tickOrchestrator.
 */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

export const OrchestratorState = Annotation.Root({
  runId: Annotation<string>,
  projectId: Annotation<string>,
  phase: Annotation<string>,
  stopRequested: Annotation<boolean>,
});

export type OrchestratorStateType = typeof OrchestratorState.State;

/** Declarative phase machine (for tooling / future interrupt wiring). */
export function buildOrchestratorGraph() {
  const g = new StateGraph(OrchestratorState)
    .addNode('intake', async (s) => ({ ...s, phase: 'clarify' }))
    .addNode('clarify', async (s) => ({ ...s, phase: 'agree_review_policy' }))
    .addNode('agree_review_policy', async (s) => ({ ...s, phase: 'plan' }))
    .addNode('plan', async (s) => ({ ...s, phase: 'ensure_staff' }))
    .addNode('ensure_staff', async (s) => ({ ...s, phase: 'assign' }))
    .addNode('assign', async (s) => ({ ...s, phase: 'wait_events' }))
    .addNode('wait_events', async (s) => ({ ...s, phase: 'synthesize' }))
    .addNode('synthesize', async (s) =>
      s.stopRequested ? { ...s, phase: 'stopped' } : { ...s, phase: 'completed' },
    )
    .addEdge(START, 'intake')
    .addEdge('intake', 'clarify')
    .addEdge('clarify', 'agree_review_policy')
    .addEdge('agree_review_policy', 'plan')
    .addEdge('plan', 'ensure_staff')
    .addEdge('ensure_staff', 'assign')
    .addEdge('assign', 'wait_events')
    .addEdge('wait_events', 'synthesize')
    .addConditionalEdges('synthesize', (s) =>
      s.stopRequested || s.phase === 'stopped' ? 'end_stopped' : 'end_done',
    )
    .addNode('end_stopped', async (s) => ({ ...s, phase: 'stopped' }))
    .addNode('end_done', async (s) => ({ ...s, phase: 'completed' }))
    .addEdge('end_stopped', END)
    .addEdge('end_done', END);

  return g.compile();
}
