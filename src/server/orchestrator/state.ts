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

/** Last-write-wins — Command.update + node return can both write in one step. */
function lastWrite<T>(left: T, right: T): T {
  return right !== undefined && right !== null ? right : left;
}

export const OrchestratorState = Annotation.Root({
  runId: Annotation<string>,
  projectId: Annotation<string>,
  goal: Annotation<string>({
    reducer: lastWrite,
    default: () => '',
  }),
  phase: Annotation<string>({
    reducer: lastWrite,
    default: () => 'intake',
  }),
  status: Annotation<string>({
    reducer: lastWrite,
    default: () => 'running',
  }),
  checkpoint: Annotation<Record<string, unknown>>({
    reducer: (left, right) => ({ ...(left ?? {}), ...(right ?? {}) }),
    default: () => ({}),
  }),
  plan: Annotation<OrchestratorPlan | null>({
    reducer: lastWrite,
    default: () => null,
  }),
  pendingCommand: Annotation<PendingCommand | null>({
    reducer: lastWrite,
    default: () => null,
  }),
  stopRequested: Annotation<boolean>({
    reducer: lastWrite,
    default: () => false,
  }),
  skipClarify: Annotation<boolean>({
    reducer: lastWrite,
    default: () => false,
  }),
  forceReplan: Annotation<boolean>({
    reducer: lastWrite,
    default: () => false,
  }),
  halt: Annotation<boolean>({
    reducer: lastWrite,
    default: () => false,
  }),
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
