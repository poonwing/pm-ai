import { END, START, StateGraph } from '@langchain/langgraph';
import { OrchestratorState, type OrchestratorStateType } from './state.js';
import { getOrchestratorCheckpointer } from './checkpointer.js';
import {
  guardTerminalNode,
  checkOpenDecisionsNode,
  markClarifiedNode,
  routeAfterGuard,
  routeAfterOpenDecisions,
} from './nodes/guard.js';
import { researchNode } from './nodes/research.js';
import { clarifyNode } from './nodes/clarify.js';
import {
  agreeReviewPolicyNode,
  routeAfterPolicy,
} from './nodes/agree-review-policy.js';
import { planNode, routeAfterPlan } from './nodes/plan.js';
import {
  decisionGateNode,
  routeAfterDecisionGate,
} from './nodes/decision-gate.js';
import { meetingNode } from './nodes/meeting.js';
import { ensureStaffNode } from './nodes/ensure-staff.js';
import { assignNode } from './nodes/assign.js';
import { waitEventsNode, routeAfterWait } from './nodes/wait-events.js';
import { reconcileRunnerNode } from './nodes/reconcile-runner.js';
import { dispatchAiReviewNode } from './nodes/dispatch-ai-review.js';
import {
  synthesizeNode,
  routeAfterSynthesize,
} from './nodes/synthesize.js';
import { checkpointFlag } from './helpers.js';

async function endStoppedNode(state: OrchestratorStateType) {
  return state;
}

async function endDoneNode(state: OrchestratorStateType) {
  return state;
}

function routeAfterResearch(state: OrchestratorStateType): string {
  if (!checkpointFlag(state.checkpoint, 'research_done')) return '__interrupt__';
  if (
    state.skipClarify ||
    checkpointFlag(state.checkpoint, 'skip_clarify_after_research')
  ) {
    return 'agreeReviewPolicy';
  }
  return 'clarify';
}

function routeAfterClarify(state: OrchestratorStateType): string {
  if (state.status === 'awaiting_human') return '__interrupt__';
  return 'agreeReviewPolicy';
}

function routeAfterAssign(state: OrchestratorStateType): string {
  if (state.status === 'completed' || state.phase === 'completed') return 'endDone';
  return 'waitEvents';
}

function mapRoute(target: string): string {
  if (target === 'endStopped') return 'endStopped';
  if (target === 'endAwaiting') return '__interrupt__';
  return target;
}

export function buildOrchestratorGraph() {
  const g = new StateGraph(OrchestratorState)
    .addNode('guardTerminal', guardTerminalNode)
    .addNode('checkOpenDecisions', checkOpenDecisionsNode)
    .addNode('markClarified', markClarifiedNode)
    .addNode('research', researchNode)
    .addNode('clarify', clarifyNode)
    .addNode('agreeReviewPolicy', agreeReviewPolicyNode)
    .addNode('planning', planNode)
    .addNode('decisionGate', decisionGateNode)
    .addNode('meeting', meetingNode)
    .addNode('ensureStaff', ensureStaffNode)
    .addNode('assign', assignNode)
    .addNode('waitEvents', waitEventsNode)
    .addNode('reconcileRunner', reconcileRunnerNode)
    .addNode('dispatchAiReview', dispatchAiReviewNode)
    .addNode('synthesize', synthesizeNode)
    .addNode('endStopped', endStoppedNode)
    .addNode('endDone', endDoneNode)
    .addEdge(START, 'guardTerminal')
    .addConditionalEdges('guardTerminal', (s) => mapRoute(routeAfterGuard(s)), {
      checkOpenDecisions: 'checkOpenDecisions',
      endStopped: 'endStopped',
    })
    .addConditionalEdges('checkOpenDecisions', (s) => mapRoute(routeAfterOpenDecisions(s)), {
      research: 'research',
      clarify: 'clarify',
      markClarified: 'markClarified',
      agreeReviewPolicy: 'agreeReviewPolicy',
      planning: 'planning',
      waitEvents: 'waitEvents',
      __interrupt__: END,
    })
    .addConditionalEdges('research', routeAfterResearch, {
      clarify: 'clarify',
      agreeReviewPolicy: 'agreeReviewPolicy',
      __interrupt__: END,
    })
    .addConditionalEdges('clarify', routeAfterClarify, {
      agreeReviewPolicy: 'agreeReviewPolicy',
      __interrupt__: END,
    })
    .addEdge('markClarified', 'agreeReviewPolicy')
    .addConditionalEdges('agreeReviewPolicy', (s) => mapRoute(routeAfterPolicy(s)), {
      planning: 'planning',
      __interrupt__: END,
    })
    .addConditionalEdges('planning', routeAfterPlan, {
      decisionGate: 'decisionGate',
      meeting: 'meeting',
      ensureStaff: 'ensureStaff',
    })
    .addConditionalEdges('decisionGate', (s) => mapRoute(routeAfterDecisionGate(s)), {
      ensureStaff: 'ensureStaff',
      __interrupt__: END,
    })
    .addEdge('meeting', 'ensureStaff')
    .addEdge('ensureStaff', 'assign')
    .addConditionalEdges('assign', routeAfterAssign, {
      waitEvents: 'waitEvents',
      endDone: 'endDone',
    })
    .addConditionalEdges('waitEvents', routeAfterWait, {
      planning: 'planning',
      reconcileRunner: 'reconcileRunner',
      endDone: 'endDone',
    })
    .addEdge('reconcileRunner', 'dispatchAiReview')
    .addEdge('dispatchAiReview', 'synthesize')
    .addConditionalEdges('synthesize', routeAfterSynthesize, {
      waitEvents: 'waitEvents',
      endDone: 'endDone',
    })
    .addEdge('endStopped', END)
    .addEdge('endDone', END);

  return g.compile({ checkpointer: getOrchestratorCheckpointer() });
}

let _compiled: ReturnType<typeof buildOrchestratorGraph> | null = null;

export function getCompiledOrchestratorGraph() {
  if (!_compiled) _compiled = buildOrchestratorGraph();
  return _compiled;
}
