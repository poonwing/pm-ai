import { Annotation } from '@langchain/langgraph';
import type { OrchestratorPlan } from './helpers.js';

export type PendingCommand =
  | { type: 'user_message'; text: string }
  | { type: 'task_event'; taskId: string; event: string }
  | { type: 'decision_resolved'; decisionId: string; optionId?: string }
  | { type: 'stop' }
  | { type: 'force_replan' }
  | { type: 'force_redesign' }
  | { type: 'skip_clarify' }
  | { type: 'retry_runner' }
  | { type: 'tick' };

export const OrchestratorState = Annotation.Root({
  runId: Annotation<string>,
  projectId: Annotation<string>,
  goal: Annotation<string>,
  phase: Annotation<string>,
  status: Annotation<string>,
  checkpoint: Annotation<Record<string, unknown>>,
  plan: Annotation<OrchestratorPlan | null>,
  pendingCommand: Annotation<PendingCommand | null>,
  stopRequested: Annotation<boolean>,
  skipClarify: Annotation<boolean>,
  forceReplan: Annotation<boolean>,
  halt: Annotation<boolean>,
  createdTaskIds: Annotation<string[]>({
    reducer: (_left, right) => right ?? [],
    default: () => [],
  }),
});

export type OrchestratorStateType = typeof OrchestratorState.State;

export function buildInitialGraphState(input: {
  runId: string;
  projectId: string;
  goal: string;
  checkpoint?: Record<string, unknown>;
  skipClarify?: boolean;
}): OrchestratorStateType {
  return {
    runId: input.runId,
    projectId: input.projectId,
    goal: input.goal,
    phase: 'intake',
    status: 'running',
    checkpoint: input.checkpoint ?? { goal: input.goal, messages: [] },
    plan: null,
    pendingCommand: null,
    stopRequested: false,
    skipClarify: input.skipClarify ?? false,
    forceReplan: false,
    halt: false,
    createdTaskIds: [],
  };
}
