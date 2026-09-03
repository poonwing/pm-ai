import type { AutoRunDebugSnapshot } from '../lib/api';
import { Badge } from './ui';

export type FlowNodeId =
  | 'start'
  | 'research'
  | 'clarify'
  | 'policy'
  | 'plan'
  | 'decision'
  | 'staff'
  | 'assign'
  | 'wait'
  | 'reconcile'
  | 'ai_review'
  | 'synthesize'
  | 'done'
  | 'stopped';

type NodeDef = {
  id: FlowNodeId;
  label: string;
  hint?: string;
};

const MAIN_ROW: NodeDef[] = [
  { id: 'start', label: 'Intake', hint: '啟動 / Guard' },
  { id: 'research', label: 'Research', hint: '研究' },
  { id: 'clarify', label: 'Clarify', hint: '澄清' },
  { id: 'policy', label: 'Policy', hint: '審查協定' },
  { id: 'plan', label: 'Plan', hint: '規劃' },
];

const MID_ROW: NodeDef[] = [
  { id: 'decision', label: 'Decision', hint: '決策門' },
  { id: 'staff', label: 'Staff', hint: '建員工' },
  { id: 'assign', label: 'Assign', hint: '分派' },
];

const LOOP_ROW: NodeDef[] = [
  { id: 'wait', label: 'Wait', hint: '等待事件' },
  { id: 'reconcile', label: 'Reconcile', hint: 'Runner 對帳' },
  { id: 'ai_review', label: 'AI Review', hint: 'GLM 復查' },
  { id: 'synthesize', label: 'Synthesize', hint: '彙總' },
];

const END_NODES: NodeDef[] = [
  { id: 'done', label: 'Done' },
  { id: 'stopped', label: 'Stopped' },
];

const GRAPH_NEXT_MAP: Record<string, FlowNodeId> = {
  guardTerminal: 'start',
  checkOpenDecisions: 'start',
  markClarified: 'clarify',
  research: 'research',
  clarify: 'clarify',
  agreeReviewPolicy: 'policy',
  planning: 'plan',
  decisionGate: 'decision',
  meeting: 'staff',
  ensureStaff: 'staff',
  assign: 'assign',
  waitEvents: 'wait',
  reconcileRunner: 'reconcile',
  dispatchAiReview: 'ai_review',
  synthesize: 'synthesize',
  endDone: 'done',
  endStopped: 'stopped',
};

const PHASE_MAP: Record<string, FlowNodeId> = {
  intake: 'start',
  research: 'research',
  clarify: 'clarify',
  agree_review_policy: 'policy',
  plan: 'plan',
  planning: 'plan',
  decision: 'decision',
  meeting: 'staff',
  ensure_staff: 'staff',
  assign: 'assign',
  wait_events: 'wait',
  synthesize: 'synthesize',
  completed: 'done',
  stopped: 'stopped',
};

export function resolveActiveFlowNode(debug: AutoRunDebugSnapshot): FlowNodeId {
  if (debug.status === 'stopped' || debug.phase === 'stopped') return 'stopped';
  if (debug.status === 'completed' || debug.phase === 'completed') return 'done';

  const next = debug.graph.next?.[0];
  if (next && GRAPH_NEXT_MAP[next]) return GRAPH_NEXT_MAP[next];

  switch (debug.blockedReason) {
    case 'wait_runner':
      return 'wait';
    case 'wait_ai_review':
    case 'ai_review_cooldown':
    case 'no_model':
      return 'ai_review';
    case 'awaiting_decision':
      return 'decision';
    case 'awaiting_human':
      if (debug.phase === 'agree_review_policy') return 'policy';
      if (debug.phase === 'research') return 'research';
      if (debug.phase === 'decision') return 'decision';
      return 'clarify';
    case 'wait_events':
      return 'wait';
    default:
      break;
  }

  return PHASE_MAP[debug.phase] ?? 'wait';
}

function Arrow() {
  return (
    <span className="text-muted-foreground text-xs px-0.5 select-none shrink-0" aria-hidden>
      →
    </span>
  );
}

function FlowNode({
  node,
  active,
  pulse,
}: {
  node: NodeDef;
  active: boolean;
  pulse?: boolean;
}) {
  return (
    <div
      className={[
        'min-w-[4.5rem] max-w-[5.5rem] rounded-md border px-2 py-1.5 text-center transition-colors',
        active
          ? 'border-zinc-900 bg-zinc-900 text-white shadow-sm'
          : 'border-border bg-white text-foreground',
        pulse && active ? 'ring-2 ring-amber-400 ring-offset-1' : '',
      ].join(' ')}
      title={node.hint ?? node.label}
    >
      <div className="text-[11px] font-medium leading-tight">{node.label}</div>
      {node.hint && (
        <div
          className={`text-[9px] mt-0.5 leading-tight ${active ? 'text-zinc-300' : 'text-muted-foreground'}`}
        >
          {node.hint}
        </div>
      )}
    </div>
  );
}

function FlowRow({
  nodes,
  activeId,
  pulse,
}: {
  nodes: NodeDef[];
  activeId: FlowNodeId;
  pulse?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-y-2">
      {nodes.map((n, i) => (
        <div key={n.id} className="flex items-center">
          {i > 0 && <Arrow />}
          <FlowNode node={n} active={activeId === n.id} pulse={pulse} />
        </div>
      ))}
    </div>
  );
}

export function AutoWorkflowDiagram({ debug }: { debug: AutoRunDebugSnapshot }) {
  const activeId = resolveActiveFlowNode(debug);
  const waiting =
    debug.blockedReason === 'wait_events' ||
    debug.blockedReason === 'wait_runner' ||
    debug.blockedReason === 'wait_ai_review' ||
    debug.blockedReason === 'ai_review_cooldown' ||
    debug.blockedReason === 'awaiting_human' ||
    debug.blockedReason === 'awaiting_decision' ||
    debug.graph.pendingInterrupt;

  const runnerHot = debug.runner.activeCount > 0;
  const reviewHot =
    debug.aiReviewActivity.status === 'in_flight' ||
    debug.aiReviewActivity.pendingCount > 0;

  const activeLabel =
    [...MAIN_ROW, ...MID_ROW, ...LOOP_ROW, ...END_NODES].find((n) => n.id === activeId)
      ?.label ?? activeId;

  return (
    <div className="border border-border rounded-md bg-white p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-muted-foreground">工作流泳道</div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <Badge className="bg-zinc-900 text-white">當前 · {activeLabel}</Badge>
          {debug.graph.pendingInterrupt && (
            <Badge className="bg-amber-100 text-amber-900">interrupt</Badge>
          )}
          {waiting && <Badge className="bg-amber-50 text-amber-800">waiting</Badge>}
        </div>
      </div>

      <div className="flex flex-col gap-2 overflow-x-auto">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            主路徑
          </div>
          <FlowRow nodes={MAIN_ROW} activeId={activeId} pulse={waiting} />
        </div>

        <div className="text-[10px] text-muted-foreground pl-1">↓ 規劃後</div>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            分派
          </div>
          <FlowRow nodes={MID_ROW} activeId={activeId} pulse={waiting} />
        </div>

        <div className="text-[10px] text-muted-foreground pl-1">↓ 執行迴圈</div>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            Wait ⇄ 復查 ⇄ 彙總
          </div>
          <FlowRow nodes={LOOP_ROW} activeId={activeId} pulse={waiting} />
          <p className="text-[10px] text-muted-foreground mt-1">
            Synthesize 後通常回到 Wait；全部完成則進 Done
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-[10px] text-muted-foreground">結束</span>
          {END_NODES.map((n) => (
            <FlowNode key={n.id} node={n} active={activeId === n.id} />
          ))}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-2 pt-1 border-t border-border/60">
        <div
          className={`rounded-md border px-2.5 py-2 text-xs ${
            runnerHot ? 'border-sky-300 bg-sky-50' : 'border-border bg-zinc-50'
          }`}
        >
          <div className="font-medium text-[11px] mb-0.5">旁路 · Runner</div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            {runnerHot
              ? `${debug.runner.activeCount} 個進行中（${debug.runner.provider}）— 對應 Wait 節點`
              : '目前無進行中的 Runner job'}
          </p>
        </div>
        <div
          className={`rounded-md border px-2.5 py-2 text-xs ${
            reviewHot ? 'border-violet-300 bg-violet-50' : 'border-border bg-zinc-50'
          }`}
        >
          <div className="font-medium text-[11px] mb-0.5">旁路 · AI 復查</div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            {debug.aiReviewActivity.summary}
          </p>
        </div>
      </div>
    </div>
  );
}
