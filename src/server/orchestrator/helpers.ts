import { getRunnerStatus } from '../runner/index.js';
import {
  forceUnlockTask,
  getTask,
  listProjectTasks,
  reopenTask,
} from '../services/tasks.js';
import type { DecisionOption } from '../services/auto.js';
import { CUSTOM_DECISION_OPTION_ID } from '../../shared/schemas.js';
import type { getAutoRun } from '../services/auto.js';

export type OrchestratorPhase =
  | 'intake'
  | 'research'
  | 'clarify'
  | 'agree_review_policy'
  | 'plan'
  | 'ensure_staff'
  | 'assign'
  | 'wait_events'
  | 'synthesize'
  | 'meeting'
  | 'decision'
  | 'completed'
  | 'stopped';

export interface PlanTask {
  title: string;
  goal: string;
  acceptance_criteria: string;
  role: string;
  queue_order: number;
  reviewer_type: 'human' | 'agent' | 'orchestrator' | 'none';
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
  return {
    ...plan,
    tasks: (plan.tasks ?? []).map((t) => ({
      ...t,
      title: coercePlanText(t.title).trim() || '未命名任務',
      goal: coercePlanText(t.goal),
      acceptance_criteria: coercePlanText(t.acceptance_criteria),
    })),
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
    phase: 'agree_review_policy',
    checkpoint: {
      ...run.checkpoint,
      clarified: true,
      clarified_at: new Date().toISOString(),
    },
  });
}
