import { getRunnerStatus } from '../runner/index.js';
import {
  forceUnlockTask,
  getTask,
  listProjectTasks,
  reopenTask,
} from '../services/tasks.js';
import type { DecisionOption } from '../services/auto.js';
import { getAutoRun } from '../services/auto.js';
import { CUSTOM_DECISION_OPTION_ID, isPendingReview } from '../../shared/schemas.js';

export type OrchestratorPhase =
  | 'intake'
  | 'research'
  | 'clarify'
  | 'agree_review_policy'
  | 'design'
  | 'plan'
  | 'ensure_staff'
  | 'assign'
  | 'wait_events'
  | 'synthesize'
  | 'meeting'
  | 'decision'
  | 'completed'
  | 'stopped';

export type DesignStage = 'system' | 'data' | 'coding' | 'ui';

export const DESIGN_STAGE_ORDER: DesignStage[] = ['system', 'data', 'coding', 'ui'];

export const DESIGN_STAGE_LABELS: Record<DesignStage, string> = {
  system: '系統設計 (System Design)',
  data: '資料設計 (Data Design)',
  coding: '編碼設計 (Coding Design)',
  ui: '介面設計 (UI Design)',
};

export interface DesignCheckpoint {
  active_stage: DesignStage | 'done';
  skipped: DesignStage[];
  artifacts: Partial<Record<DesignStage, string>>;
  confirmed: Partial<Record<DesignStage, boolean>>;
  /** True when all required stages are confirmed or skipped. */
  design_done?: boolean;
}

export interface FeedbackItem {
  id: string;
  from_task_id: string;
  target_role: string;
  target_stage?: DesignStage | null;
  message: string;
  status: 'pending' | 'handled' | 'escalated';
  action?: 'revise_artifact' | 'reopen_task' | 'note_only' | null;
  created_at: string;
  chain_count?: number;
}

export interface DispatchCheckpoint {
  /** plan task id → created workspace task id */
  task_map: Record<string, string>;
  /** plan task ids already enqueued to Runner */
  enqueued: string[];
  waves_done: number;
}

export interface PlanTask {
  id: string;
  title: string;
  goal: string;
  acceptance_criteria: string;
  role: string;
  queue_order: number;
  reviewer_type: 'human' | 'agent' | 'orchestrator' | 'none';
  depends_on: string[];
}

export interface OrchestratorPlan {
  summary: string;
  staff: Array<{ name: string; role: string; system_prompt: string; skills_tags: string[] }>;
  tasks: PlanTask[];
  need_decision?: boolean;
  decision?: {
    title: string;
    summary: string;
    options: Array<{ id: string; label: string; description?: string }>;
    recommended_option_id?: string;
  };
  need_meeting?: boolean;
  meeting_topic?: string;
}

export const MAX_FEEDBACK_CHAIN = 3;
export const REQUIREMENT_CHANGE_DECISION_TITLE = '需求變更處理方式';

export interface ClarifyResult {
  reply: string;
  requirements_summary: string;
  updated_goal: string | null;
  ready_to_execute: boolean;
}

export const RUNNER_ORCH_MAX_RETRIES = 2;

export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }
    throw new Error(`模型未返回有效 JSON：${raw.slice(0, 200)}`);
  }
}

export function coercePlanText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .filter((item) => item.trim().length > 0)
      .join('\n');
  }
  return String(value);
}

export function normalizePlan(plan: OrchestratorPlan): OrchestratorPlan {
  const usedIds = new Set<string>();
  return {
    ...plan,
    tasks: (plan.tasks ?? []).map((t, index) => {
      let id = coercePlanText((t as PlanTask).id).trim() || `t${index + 1}`;
      id = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || `t${index + 1}`;
      let unique = id;
      let n = 2;
      while (usedIds.has(unique)) {
        unique = `${id}_${n}`;
        n += 1;
      }
      usedIds.add(unique);
      const dependsRaw = (t as PlanTask).depends_on;
      const depends_on = Array.isArray(dependsRaw)
        ? dependsRaw.map((d) => String(d).trim()).filter(Boolean)
        : [];
      const reviewer = String(t.reviewer_type ?? 'human');
      const reviewer_type = (
        ['human', 'agent', 'orchestrator', 'none'].includes(reviewer)
          ? reviewer
          : 'human'
      ) as PlanTask['reviewer_type'];
      return {
        id: unique,
        title: coercePlanText(t.title).trim() || '未命名任務',
        goal: coercePlanText(t.goal),
        acceptance_criteria: coercePlanText(t.acceptance_criteria),
        role: coercePlanText(t.role).trim() || 'developer',
        queue_order: Number.isFinite(Number(t.queue_order)) ? Number(t.queue_order) : index + 1,
        reviewer_type,
        depends_on,
      };
    }),
  };
}

export function isWaitingPhase(phase: string): boolean {
  return phase === 'wait_events' || phase === 'synthesize';
}

export function isClarifyPhase(phase: string): boolean {
  return phase === 'intake' || phase === 'clarify';
}

export function isResearchPhase(phase: string): boolean {
  return phase === 'research';
}

export function isDesignPhase(phase: string): boolean {
  return phase === 'design';
}

export function emptyDesignCheckpoint(skipped: DesignStage[] = []): DesignCheckpoint {
  const first =
    DESIGN_STAGE_ORDER.find((s) => !skipped.includes(s)) ?? ('done' as const);
  return {
    active_stage: first === 'done' || skipped.length === DESIGN_STAGE_ORDER.length ? 'done' : first,
    skipped,
    artifacts: {},
    confirmed: Object.fromEntries(skipped.map((s) => [s, true])) as Partial<
      Record<DesignStage, boolean>
    >,
    design_done: skipped.length === DESIGN_STAGE_ORDER.length || first === 'done',
  };
}

export function designFromCheckpoint(
  checkpoint: Record<string, unknown> | undefined | null,
): DesignCheckpoint | null {
  const raw = checkpoint?.design;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Partial<DesignCheckpoint>;
  const skipped = Array.isArray(d.skipped)
    ? d.skipped.filter((s): s is DesignStage => DESIGN_STAGE_ORDER.includes(s as DesignStage))
    : [];
  const active =
    d.active_stage === 'done' || DESIGN_STAGE_ORDER.includes(d.active_stage as DesignStage)
      ? (d.active_stage as DesignStage | 'done')
      : emptyDesignCheckpoint(skipped).active_stage;
  return {
    active_stage: active,
    skipped,
    artifacts:
      d.artifacts && typeof d.artifacts === 'object' && !Array.isArray(d.artifacts)
        ? (d.artifacts as DesignCheckpoint['artifacts'])
        : {},
    confirmed:
      d.confirmed && typeof d.confirmed === 'object' && !Array.isArray(d.confirmed)
        ? (d.confirmed as DesignCheckpoint['confirmed'])
        : {},
    design_done: Boolean(d.design_done) || active === 'done',
  };
}

export function isDesignDone(checkpoint: Record<string, unknown> | undefined | null): boolean {
  const d = designFromCheckpoint(checkpoint);
  return Boolean(d?.design_done || d?.active_stage === 'done');
}

export function formatDesignArtifacts(
  checkpoint: Record<string, unknown> | undefined | null,
): string {
  const d = designFromCheckpoint(checkpoint);
  if (!d) return '（尚無設計產物）';
  const parts: string[] = [];
  for (const stage of DESIGN_STAGE_ORDER) {
    if (d.skipped.includes(stage)) {
      parts.push(`## ${DESIGN_STAGE_LABELS[stage]}\n（已跳過）`);
      continue;
    }
    const art = d.artifacts[stage]?.trim();
    if (art) parts.push(`## ${DESIGN_STAGE_LABELS[stage]}\n${art}`);
  }
  return parts.join('\n\n') || '（尚無設計產物）';
}

export function nextDesignStage(
  current: DesignStage,
  skipped: DesignStage[],
): DesignStage | 'done' {
  const idx = DESIGN_STAGE_ORDER.indexOf(current);
  for (let i = idx + 1; i < DESIGN_STAGE_ORDER.length; i++) {
    if (!skipped.includes(DESIGN_STAGE_ORDER[i])) return DESIGN_STAGE_ORDER[i];
  }
  return 'done';
}

export function rollbackDesignTo(
  design: DesignCheckpoint,
  target: DesignStage,
): DesignCheckpoint {
  const targetIdx = DESIGN_STAGE_ORDER.indexOf(target);
  const confirmed = { ...design.confirmed };
  const artifacts = { ...design.artifacts };
  for (const stage of DESIGN_STAGE_ORDER) {
    if (DESIGN_STAGE_ORDER.indexOf(stage) >= targetIdx && !design.skipped.includes(stage)) {
      delete confirmed[stage];
      if (stage !== target) delete artifacts[stage];
    }
  }
  return {
    ...design,
    active_stage: target,
    confirmed,
    artifacts,
    design_done: false,
  };
}

export function dispatchFromCheckpoint(
  checkpoint: Record<string, unknown> | undefined | null,
): DispatchCheckpoint {
  const raw = checkpoint?.dispatch;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { task_map: {}, enqueued: [], waves_done: 0 };
  }
  const d = raw as Partial<DispatchCheckpoint>;
  return {
    task_map:
      d.task_map && typeof d.task_map === 'object' && !Array.isArray(d.task_map)
        ? (d.task_map as Record<string, string>)
        : {},
    enqueued: Array.isArray(d.enqueued) ? d.enqueued.filter((x) => typeof x === 'string') : [],
    waves_done: Number.isFinite(Number(d.waves_done)) ? Number(d.waves_done) : 0,
  };
}

export function feedbackQueueFromCheckpoint(
  checkpoint: Record<string, unknown> | undefined | null,
): FeedbackItem[] {
  const raw = checkpoint?.feedback_queue;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is FeedbackItem => Boolean(x && typeof x === 'object' && 'id' in x));
}

export function isTaskDependencySatisfied(
  planTaskId: string,
  plan: OrchestratorPlan,
  dispatch: DispatchCheckpoint,
  projectId: string,
): boolean {
  const planTask = plan.tasks.find((t) => t.id === planTaskId);
  if (!planTask) return false;
  for (const depId of planTask.depends_on ?? []) {
    const realId = dispatch.task_map[depId];
    if (!realId) return false;
    let task;
    try {
      task = getTask(projectId, realId);
    } catch {
      return false;
    }
    if (task.status === 'cancelled') continue;
    if (task.status !== 'done') return false;
    if (isPendingReview(task as Parameters<typeof isPendingReview>[0])) return false;
  }
  return true;
}

export function readyPlanTasks(
  plan: OrchestratorPlan,
  dispatch: DispatchCheckpoint,
  projectId: string,
): PlanTask[] {
  const enqueued = new Set(dispatch.enqueued);
  return (plan.tasks ?? []).filter((t) => {
    if (enqueued.has(t.id)) return false;
    if (dispatch.task_map[t.id]) {
      // created but not yet enqueued — still ready to enqueue
      return isTaskDependencySatisfied(t.id, plan, dispatch, projectId);
    }
    return isTaskDependencySatisfied(t.id, plan, dispatch, projectId);
  });
}

export function isConfirmDesignRequest(message: string): boolean {
  const t = message.trim();
  if (/^\/(confirm|ok|approve)\b/i.test(t)) return true;
  return /確認設計|确认设计|確認此階段|确认此阶段|同意設計|同意设计|可以進入下|可以进入下|設計沒問題|设计没问题|沒問題.*繼續|没问题.*继续|確認並繼續|确认并继续/.test(
    t,
  );
}

export function isStartWorkRequest(message: string): boolean {
  const t = message.trim();
  if (/^\/(start|go|run|execute)\b/i.test(t)) return true;
  return /開始工作|开始工作|立刻開工|立刻开工|馬上開始|马上开始|立即開始|立即开始|可以開工|可以开工|開工吧|开工吧|直接開始|直接开始|開始執行|开始执行|直接幹|直接干|別問了|别问了|夠了.*開始|够了.*开始/.test(
    t,
  );
}

export function isExplicitReplanRequest(message: string): boolean {
  const t = message.trim();
  if (/^\/(replan|plan|tick)\b/i.test(t)) return true;
  return /重新規劃|重新计划|再規劃|再计划|重新分派|再分派/.test(t);
}

export function isRetryRunnerRequest(message: string): boolean {
  const t = message.trim();
  if (/^\/retry\b/i.test(t)) return true;
  return /重試|重试|再試|再试|重新執行|重新执行|重新跑|再跑一遍/.test(t);
}

/** User asks how many agents are working / current progress (not a replan instruction). */
export function isStatusInquiry(message: string): boolean {
  const t = message.trim();
  if (/^\/(status|progress|stats)\b/i.test(t)) return true;
  if (/^(進度|进度)如何|怎么样了|怎樣了|什么进度|什麼進度/.test(t)) return true;
  const asksWhen = /多少|幾個|几个|幾多|几多|有多少|目前|現在|现在|还在|還在/.test(t);
  const asksWhat =
    /agent|員工|员工|人|工作|在跑|在幹|在干|執行|执行|進度|进度|狀態|状态|runner|任務|任务/.test(
      t,
    );
  return asksWhen && asksWhat;
}

export function isRequirementChangeRequest(message: string): boolean {
  const t = message.trim();
  if (/^\/(change|req|requirement)\b/i.test(t)) return true;
  if (isExplicitReplanRequest(t) || isStatusInquiry(t) || isRetryRunnerRequest(t)) return false;
  return /改需求|变更需求|變更需求|需求變|需求变|不要這樣|不要这样|重新做|改成|改為|改为|另外想|其實我想|其实我想|範圍改|范围改|加一個功能|加一个功能|取消這個|取消这个/.test(
    t,
  );
}

export function checkpointFlag(
  checkpoint: Record<string, unknown> | undefined | null,
  key: string,
): boolean {
  return Boolean(checkpoint && checkpoint[key] === true);
}

export function researchReportFromCheckpoint(
  checkpoint: Record<string, unknown> | undefined | null,
): string {
  if (!checkpoint) return '';
  const report = checkpoint.research_report;
  return typeof report === 'string' ? report.trim() : '';
}

export function isClarified(checkpoint: Record<string, unknown> | undefined | null): boolean {
  return Boolean(checkpoint && checkpoint.clarified === true);
}

export function runnerRetryCountsFromCheckpoint(
  checkpoint: Record<string, unknown> | undefined | null,
): Record<string, number> {
  const raw = checkpoint?.runner_retry_counts;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, number>;
}

export function runnerStallNotifiedFromCheckpoint(
  checkpoint: Record<string, unknown> | undefined | null,
): string[] {
  const raw = checkpoint?.runner_stall_notified;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id) => typeof id === 'string');
}

export function createdTaskIdsFromCheckpoint(
  checkpoint: Record<string, unknown> | undefined | null,
): string[] {
  const raw = checkpoint?.created_task_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id) => typeof id === 'string');
}

export function collectRunTaskIds(
  run: ReturnType<typeof getAutoRun>,
  opts?: { includeAllPending?: boolean },
): string[] {
  const ids = new Set<string>();
  for (const id of createdTaskIdsFromCheckpoint(run.checkpoint)) ids.add(id);
  const researchId = run.checkpoint.research_task_id;
  if (typeof researchId === 'string') ids.add(researchId);

  if (opts?.includeAllPending) {
    for (const t of listProjectTasks(run.project_id)) {
      if (t.status === 'todo' || t.status === 'in_progress') ids.add(t.id);
    }
  }

  return [...ids];
}

export type RunProgressEvaluation = {
  tasks: ReturnType<typeof listProjectTasks>;
  open: ReturnType<typeof listProjectTasks>;
  done: ReturnType<typeof listProjectTasks>;
  cancelled: ReturnType<typeof listProjectTasks>;
  pendingReview: ReturnType<typeof listProjectTasks>;
  pendingAi: ReturnType<typeof listProjectTasks>;
  pendingHuman: ReturnType<typeof listProjectTasks>;
  /** No open work and no pending reviews → Auto Run may complete. */
  canComplete: boolean;
  summary: string;
  scopedToRun: boolean;
};

/**
 * Decide whether this Auto Run's work is finished.
 * - Prefer tasks in checkpoint `created_task_ids` (+ research task).
 * - `cancelled` counts as terminal (same as done for completion).
 * - Pending AI/human review on done tasks still blocks completion.
 */
export function evaluateRunProgress(
  projectId: string,
  runId: string,
): RunProgressEvaluation {
  const run = getAutoRun(runId);
  const runIds = new Set(collectRunTaskIds(run));
  const all = listProjectTasks(projectId);
  const scopedToRun = runIds.size > 0;
  const tasks = scopedToRun ? all.filter((t) => runIds.has(t.id)) : all;

  const done = tasks.filter((t) => t.status === 'done');
  const cancelled = tasks.filter((t) => t.status === 'cancelled');
  // Open = still actionable. Draft outside a run scope should not forever block Auto completion.
  const open = scopedToRun
    ? tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
    : tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const pendingReview = done.filter((t) =>
    isPendingReview(t as Parameters<typeof isPendingReview>[0]),
  );
  const pendingAi = pendingReview.filter(
    (t) => t.review?.reviewer_type === 'agent' || t.review?.reviewer_type === 'orchestrator',
  );
  const pendingHuman = pendingReview.filter(
    (t) => !t.review || t.review.reviewer_type === 'human',
  );

  const canComplete =
    scopedToRun && open.length === 0 && pendingReview.length === 0;

  const scope = scopedToRun ? '本 Run' : '專案';
  const summary = [
    `進度（${scope}）：共 ${tasks.length} 任務，完成 ${done.length}，已取消 ${cancelled.length}，未結束 ${open.length}`,
    `待 AI 復查 ${pendingAi.length}，待人驗收 ${pendingHuman.length}`,
  ].join('，');

  return {
    tasks,
    open,
    done,
    cancelled,
    pendingReview,
    pendingAi,
    pendingHuman,
    canComplete,
    summary,
    scopedToRun,
  };
}

export function hasActiveRunnerJob(
  jobs: ReturnType<typeof getRunnerStatus>['jobs'],
  taskId: string,
): boolean {
  return jobs.some(
    (j) =>
      j.taskId === taskId &&
      (j.status === 'queued' || j.status === 'claiming' || j.status === 'running'),
  );
}

export function latestRunnerJob(
  jobs: ReturnType<typeof getRunnerStatus>['jobs'],
  taskId: string,
) {
  return jobs
    .filter((j) => j.taskId === taskId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function prepareTaskForRunnerRetry(projectId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  if (task.status !== 'in_progress') return task;
  if (task.lease?.leaseToken) return task;
  try {
    forceUnlockTask(projectId, taskId);
  } catch {
    /* ignore */
  }
  try {
    return reopenTask(projectId, taskId);
  } catch {
    return getTask(projectId, taskId);
  }
}

export type ParsedDecisionReply = { optionId: string; note?: string };

export function tryParseDecisionReply(
  options: DecisionOption[],
  message: string,
): ParsedDecisionReply | null {
  const t = message.trim();
  if (!t) return null;

  const preset = options.filter((o) => o.id !== CUSTOM_DECISION_OPTION_ID);

  const cmd = t.match(/^\/(?:decide|選擇|选择)\s+(.+)$/is);
  const body = (cmd ? cmd[1] : t).trim();

  const customPrefixed = body.match(/^(?:自訂|自定义|custom)\s*[:：]\s*(.+)$/is);
  if (customPrefixed?.[1]?.trim()) {
    return { optionId: CUSTOM_DECISION_OPTION_ID, note: customPrefixed[1].trim() };
  }
  const customCmd = t.match(/^\/custom\s+(.+)$/is);
  if (customCmd?.[1]?.trim()) {
    return { optionId: CUSTOM_DECISION_OPTION_ID, note: customCmd[1].trim() };
  }

  if (/^\d+$/.test(body)) {
    const n = Number(body);
    if (n >= 1 && n <= preset.length) {
      return { optionId: preset[n - 1].id };
    }
    return null;
  }

  const lower = body.toLowerCase();
  const byId = preset.find((o) => o.id.toLowerCase() === lower);
  if (byId) return { optionId: byId.id };

  const byLabel = preset.find((o) => o.label.trim().toLowerCase() === lower);
  if (byLabel) return { optionId: byLabel.id };

  if (cmd) return null;

  return null;
}

export function decisionChatHint(options: DecisionOption[]): string {
  const preset = options.filter((o) => o.id !== CUSTOM_DECISION_OPTION_ID);
  const lines = preset.map((o, i) => `${i + 1}. ${o.label}`);
  return [
    '已記下你的補充（尚未決策）。也可直接在對話框決策：',
    ...lines,
    '回覆序號（如 1）、選項原文，或「自訂：你的決定」。下方按鈕同樣可用。',
  ].join('\n');
}

export function markClarifiedAndContinue(
  runId: string,
  note: string | undefined,
  append: (runId: string, role: string, content: string) => void,
  update: (
    runId: string,
    patch: {
      status: string;
      phase: string;
      checkpoint: Record<string, unknown>;
    },
  ) => void,
  getRun: (runId: string) => ReturnType<typeof getAutoRun>,
) {
  if (note) append(runId, 'assistant', note);
  const run = getRun(runId);
  update(runId, {
    status: 'running',
    phase: 'design',
    checkpoint: {
      ...run.checkpoint,
      clarified: true,
      clarified_at: new Date().toISOString(),
    },
  });
}
