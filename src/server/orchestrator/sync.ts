import {
  getAutoRun,
  getAutoRunMessages,
  listDecisions,
  updateAutoRun,
} from '../services/auto.js';
import {
  checkpointFlag,
  createdTaskIdsFromCheckpoint,
  isClarified,
  type OrchestratorPlan,
} from './helpers.js';
import type { OrchestratorStateType } from './state.js';

export type TickResult = {
  run: ReturnType<typeof getAutoRun>;
  messages: ReturnType<typeof getAutoRunMessages>;
  decisions?: ReturnType<typeof listDecisions>;
  tasks?: string[];
};

export function syncRunMirror(state: Pick<
  OrchestratorStateType,
  'runId' | 'phase' | 'status' | 'checkpoint' | 'goal'
>) {
  updateAutoRun(state.runId, {
    phase: state.phase,
    status: state.status,
    checkpoint: state.checkpoint,
    ...(state.goal ? { goal: state.goal } : {}),
  });
}

export function runResult(runId: string, extra?: Partial<TickResult>): TickResult {
  return {
    run: getAutoRun(runId),
    messages: getAutoRunMessages(runId),
    ...extra,
  };
}

/** Merge auto_runs mirror into graph state (LangGraph checkpoint may lag behind interrupt side-effects). */
export function hydrateStateFromRun(
  runId: string,
  graphValues?: Partial<OrchestratorStateType>,
): Partial<OrchestratorStateType> {
  const run = getAutoRun(runId);
  const dbCp = run.checkpoint ?? {};
  const graphCp = graphValues?.checkpoint ?? {};
  return {
    phase: run.phase,
    status: run.status,
    goal: run.goal,
    checkpoint: { ...graphCp, ...dbCp },
    plan: (dbCp.plan as OrchestratorPlan | undefined) ?? graphValues?.plan ?? null,
    createdTaskIds: createdTaskIdsFromCheckpoint(dbCp),
    skipClarify:
      checkpointFlag(dbCp, 'skip_clarify_after_research') || isClarified(dbCp),
  };
}

export function graphHasPendingInterrupt(snapshot: {
  tasks?: Array<{ interrupts?: unknown[] }>;
  interrupts?: unknown[];
}): boolean {
  if (Array.isArray(snapshot.interrupts) && snapshot.interrupts.length > 0) return true;
  return Boolean(snapshot.tasks?.some((t) => Array.isArray(t.interrupts) && t.interrupts.length > 0));
}
