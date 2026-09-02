import { interrupt } from '@langchain/langgraph';
import { getAutoRun, getReviewPolicy, listDecisions, stopAutoRun } from '../../services/auto.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';
import { isClarified, checkpointFlag } from '../helpers.js';

export async function guardTerminalNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const run = getAutoRun(state.runId);
  if (run.status === 'stopped' || run.status === 'completed' || run.status === 'paused') {
    return { halt: true, status: run.status, phase: run.phase };
  }

  if (state.pendingCommand?.type === 'stop' || state.stopRequested) {
    stopAutoRun(state.runId);
    void import('../../runner/index.js').then((m) => m.cancelForAutoRun(state.runId));
    const next = {
      ...state,
      halt: true,
      stopRequested: true,
      status: 'stopped',
      phase: 'stopped',
      pendingCommand: null,
    };
    syncRunMirror(next);
    return {
      halt: true,
      stopRequested: true,
      status: 'stopped',
      phase: 'stopped',
      pendingCommand: null,
    };
  }

  const patch: Partial<OrchestratorStateType> = { pendingCommand: null };
  if (state.pendingCommand?.type === 'skip_clarify') {
    patch.skipClarify = true;
    patch.checkpoint = { ...state.checkpoint, skip_clarify_after_research: true };
  }
  if (state.pendingCommand?.type === 'force_replan') {
    patch.forceReplan = true;
  }
  return patch;
}

export async function checkOpenDecisionsNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  if (state.halt) return {};

  const open = listDecisions(state.projectId, 'open').filter((d) => d.run_id === state.runId);
  if (!open.length) return {};

  const next = { ...state, status: 'awaiting_human', phase: 'decision' };
  syncRunMirror(next);
  interrupt({ reason: 'decision', decisionIds: open.map((d) => d.id) });
  return { status: 'awaiting_human', phase: 'decision' };
}

export function routeAfterGuard(state: OrchestratorStateType): string {
  if (state.halt || state.stopRequested) return 'endStopped';
  return 'checkOpenDecisions';
}

export function routeAfterOpenDecisions(state: OrchestratorStateType): string {
  if (state.status === 'awaiting_human' && state.phase === 'decision') {
    return 'endAwaiting';
  }
  if (state.forceReplan) return 'planning';
  if (state.phase === 'wait_events' || state.phase === 'synthesize') return 'waitEvents';
  if (!checkpointFlag(state.checkpoint, 'research_done')) return 'research';
  if (
    !state.skipClarify &&
    !isClarified(state.checkpoint) &&
    (state.phase === 'intake' || state.phase === 'clarify')
  ) {
    return 'clarify';
  }
  if (
    (state.skipClarify || checkpointFlag(state.checkpoint, 'skip_clarify_after_research')) &&
    !isClarified(state.checkpoint)
  ) {
    return 'markClarified';
  }
  if (!getReviewPolicy(state.projectId).confirmed) return 'agreeReviewPolicy';
  return 'planning';
}

export async function markClarifiedNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const next = {
    ...state,
    status: 'running',
    phase: 'agree_review_policy',
    checkpoint: {
      ...state.checkpoint,
      clarified: true,
      clarified_at: new Date().toISOString(),
    },
  };
  syncRunMirror(next);
  return {
    status: 'running',
    phase: 'agree_review_policy',
    checkpoint: next.checkpoint,
  };
}
