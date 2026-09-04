import { interrupt } from '@langchain/langgraph';
import { getAutoRun, listDecisions, stopAutoRun } from '../../services/auto.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';
import { isClarified, isDesignDone, checkpointFlag } from '../helpers.js';

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
  if (state.pendingCommand?.type === 'force_redesign') {
    patch.forceReplan = false;
    patch.checkpoint = {
      ...state.checkpoint,
      force_redesign: true,
      design: {
        active_stage: 'system',
        skipped: [],
        artifacts:
          state.checkpoint.design &&
          typeof state.checkpoint.design === 'object' &&
          !Array.isArray(state.checkpoint.design) &&
          (state.checkpoint.design as { artifacts?: unknown }).artifacts
            ? (state.checkpoint.design as { artifacts: Record<string, string> }).artifacts
            : {},
        confirmed: {},
        design_done: false,
      },
    };
  }
  return patch;
}

export async function checkOpenDecisionsNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  if (state.halt) return {};

  const { resolveDecision } = await import('../../services/auto.js');
  const open = listDecisions(state.projectId, 'open').filter((d) => d.run_id === state.runId);

  // Policy is no longer on the main path — auto-close leftover Policy decisions.
  for (const d of open.filter((x) => x.title.includes('Review Policy'))) {
    const optionId =
      d.recommended_option_id && d.options.some((o) => o.id === d.recommended_option_id)
        ? d.recommended_option_id
        : d.options.find((o) => o.id !== 'custom')?.id ?? d.options[0]?.id;
    if (!optionId) continue;
    try {
      resolveDecision(d.id, optionId, '已跳過 Review Policy（主路徑已移除）');
    } catch {
      /* ignore */
    }
  }

  const remaining = listDecisions(state.projectId, 'open').filter((d) => d.run_id === state.runId);
  if (!remaining.length) return {};

  const next = { ...state, status: 'awaiting_human', phase: 'decision' };
  syncRunMirror(next);
  interrupt({ reason: 'decision', decisionIds: remaining.map((d) => d.id) });
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
  if (checkpointFlag(state.checkpoint, 'force_redesign')) return 'design';
  if (state.forceReplan) return 'planning';
  if (state.phase === 'wait_events' || state.phase === 'synthesize') return 'waitEvents';
  if (state.phase === 'design' && !isDesignDone(state.checkpoint)) return 'design';
  // Legacy runs stuck on policy phase → skip straight to design.
  if (state.phase === 'agree_review_policy') return 'design';
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
  if (!isDesignDone(state.checkpoint)) return 'design';
  return 'planning';
}

export async function markClarifiedNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const next = {
    ...state,
    status: 'running',
    phase: 'design',
    checkpoint: {
      ...state.checkpoint,
      clarified: true,
      clarified_at: new Date().toISOString(),
    },
  };
  syncRunMirror(next);
  return {
    status: 'running',
    phase: 'design',
    checkpoint: next.checkpoint,
  };
}
