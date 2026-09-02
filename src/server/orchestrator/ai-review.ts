/**
 * AI / orchestrator review dispatch for Auto mode.
 * When tasks complete with reviewer_type agent|orchestrator, kick off a review
 * and apply approve/reject (reject re-queues the implementer via Runner).
 */
import { appendRunMessage } from '../services/auto.js';
import {
  ensureOrchestratorAgent,
  getStaffAgent,
  listStaffAgents,
} from '../services/agents.js';
import { getTaskChanges, getTaskFileDiff } from '../services/changes.js';
import {
  approveReview,
  getTask,
  listProjectTasks,
  rejectReview,
} from '../services/tasks.js';
import { isPendingReview } from '../../shared/schemas.js';
import { chatCompletion, isModelConfigured } from './model.js';

const reviewingTaskIds = new Set<string>();
const modelMissingNotified = new Set<string>();
/** Skip re-dispatch until timestamp (ms) after soft failures. */
const reviewCooldownUntil = new Map<string, number>();

const MAX_DIFF_FILES = 8;
const MAX_PATCH_CHARS = 6000;
const REVIEW_COOLDOWN_MS = 60_000;

type ReviewDecision = {
  decision: 'approve' | 'reject';
  note: string;
};

function parseJsonLoose<T>(text: string): T {
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

function isAiReviewPending(task: {
  status: string;
  human_reviewed?: boolean;
  review?: { required?: boolean; reviewer_type?: string; status?: string } | null;
}): boolean {
  if (!isPendingReview(task as Parameters<typeof isPendingReview>[0])) return false;
  const type = task.review?.reviewer_type;
  return type === 'agent' || type === 'orchestrator';
}

function resolveReviewer(projectId: string, task: ReturnType<typeof getTask>) {
  const type = task.review?.reviewer_type ?? 'agent';
  if (type === 'orchestrator') {
    const orch = ensureOrchestratorAgent(projectId);
    return { id: orch.id, name: orch.name, system_prompt: orch.system_prompt, role: orch.role };
  }

  const reviewerId = task.review?.reviewer_agent_id;
  if (reviewerId) {
    try {
      const staff = getStaffAgent(String(reviewerId));
      if (staff.project_id === projectId && staff.status !== 'retired') {
        return {
          id: staff.id,
          name: staff.name,
          system_prompt: staff.system_prompt,
          role: staff.role,
        };
      }
    } catch {
      /* fall through */
    }
  }

  const reviewers = listStaffAgents(projectId).filter(
    (a) => a.role === 'reviewer' && a.status !== 'retired',
  );
  if (reviewers[0]) {
    return {
      id: reviewers[0].id,
      name: reviewers[0].name,
      system_prompt: reviewers[0].system_prompt,
      role: reviewers[0].role,
    };
  }

  const orch = ensureOrchestratorAgent(projectId);
  return { id: orch.id, name: orch.name, system_prompt: orch.system_prompt, role: orch.role };
}

function buildChangeContext(projectId: string, taskId: string): string {
  try {
    const task = getTask(projectId, taskId);
    const summary = getTaskChanges(projectId, taskId);
    const lines: string[] = [
      `變更模式: ${summary.mode}`,
      `任務分支: ${task.git_branch ?? '（無）'}`,
      `isolation_status: ${task.isolation_status ?? 'none'}`,
      `execution_path: ${task.execution_path ?? task.worktree_path ?? '（主 workspace）'}`,
      `對照: ${summary.base_label || '—'} → ${summary.head_label || '—'}`,
      summary.warning ? `警告: ${summary.warning}` : '',
      `統計: ${summary.stats.files} 檔 +${summary.stats.additions}/-${summary.stats.deletions}`,
      '',
      '檔案列表:',
    ];
    const files = summary.files.slice(0, MAX_DIFF_FILES);
    for (const f of files) {
      lines.push(`- [${f.status}] ${f.path} (+${f.additions}/-${f.deletions})`);
    }
    if (summary.files.length > MAX_DIFF_FILES) {
      lines.push(`…另有 ${summary.files.length - MAX_DIFF_FILES} 個檔未列出`);
    }

    let patchBudget = MAX_PATCH_CHARS;
    const patches: string[] = [];
    for (const f of files) {
      if (patchBudget <= 0) break;
      if (f.binary) continue;
      try {
        const diff = getTaskFileDiff(projectId, taskId, f.path);
        if (!diff.patch) continue;
        const slice = diff.patch.slice(0, Math.min(patchBudget, 2000));
        patches.push(`### ${f.path}\n\`\`\`diff\n${slice}\n\`\`\``);
        patchBudget -= slice.length;
      } catch {
        /* skip file */
      }
    }
    if (patches.length) {
      lines.push('', '部分 diff：', ...patches);
    } else if (!summary.files.length) {
      lines.push(
        '',
        '（目前看不到對應任務分支/worktree 的變更。請勿因空 diff 就 reject；證據不足時傾向 approve 並在 note 說明。）',
      );
    }
    return lines.filter(Boolean).join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `（無法讀取變更：${msg}。證據不足時勿反覆 reject。）`;
  }
}

async function decideReview(
  reviewer: { name: string; system_prompt: string; role: string },
  task: ReturnType<typeof getTask>,
  changeContext: string,
): Promise<ReviewDecision> {
  const userPrompt = [
    `請審查任務 ${task.id}「${task.title}」。`,
    '',
    `目標: ${task.goal || '（未填）'}`,
    `驗收標準:\n${task.acceptance_criteria || '（未填）'}`,
    `約束: ${task.constraints || '（無）'}`,
    `實作者回報:\n${task.result_note || '（無）'}`,
    `Artifacts: ${(task.artifacts ?? []).join(', ') || '（無）'}`,
    '',
    '## 程式變更摘要',
    changeContext,
    '',
    '請嚴格依驗收標準判斷。若關鍵驗收未滿足、明顯缺實作、或風險過高，應 reject。',
    '僅輸出 JSON（不要 markdown 圍欄外的說明）：',
    '{"decision":"approve"|"reject","note":"簡短中文理由"}',
  ].join('\n');

  const content = await chatCompletion(
    [
      {
        role: 'system',
        content: [
          `你是 PM-AI 的審查者「${reviewer.name}」（角色 ${reviewer.role}）。`,
          reviewer.system_prompt.trim() || '請嚴格、具體地審查交付是否符合驗收標準。',
          '你只做審查，不修改程式碼。',
        ].join('\n'),
      },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.2 },
  );

  const parsed = parseJsonLoose<Partial<ReviewDecision>>(content);
  const decision = parsed.decision === 'reject' ? 'reject' : 'approve';
  const note = String(parsed.note ?? '').trim() || (decision === 'approve' ? 'AI 審查通過' : 'AI 審查未通過');
  return { decision, note };
}

async function runOneAiReview(projectId: string, runId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  if (!isAiReviewPending(task)) return;

  const reviewer = resolveReviewer(projectId, task);

  if (!isModelConfigured()) {
    reviewCooldownUntil.set(taskId, Date.now() + REVIEW_COOLDOWN_MS);
    return;
  }

  appendRunMessage(
    runId,
    'assistant',
    `正在派 ${reviewer.name}（${reviewer.role}）復查 ${taskId}「${task.title}」…`,
  );

  try {
    const changeContext = buildChangeContext(projectId, taskId);
    const result = await decideReview(reviewer, task, changeContext);

    // Re-check in case human already acted
    const latest = getTask(projectId, taskId);
    if (!isAiReviewPending(latest)) {
      appendRunMessage(runId, 'system', `任務 ${taskId} 審查狀態已變更，略過 AI 結果。`);
      return;
    }

    if (result.decision === 'approve') {
      approveReview(projectId, taskId, {
        note: result.note,
        actor: 'agent',
        actorName: reviewer.name,
      });
      appendRunMessage(
        runId,
        'assistant',
        `${reviewer.name} 已通過 ${taskId}：${result.note}`,
      );
    } else {
      rejectReview(projectId, taskId, result.note, {
        actor: 'agent',
        actorName: reviewer.name,
      });
      appendRunMessage(
        runId,
        'assistant',
        `${reviewer.name} 退回 ${taskId}：${result.note}。將重新提交 Runner 實作。`,
      );
      const { enqueueRunnerJob } = await import('../runner/index.js');
      enqueueRunnerJob({ projectId, taskId, autoRunId: runId });
    }

    reviewCooldownUntil.delete(taskId);
    void import('./index.js')
      .then((m) => m.resumeOrchestrator(runId))
      .catch(() => undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendRunMessage(runId, 'system', `任務 ${taskId} AI 復查失敗：${msg}`);
    reviewCooldownUntil.set(taskId, Date.now() + REVIEW_COOLDOWN_MS);
  }
}

/** Find done tasks awaiting agent/orchestrator review and start reviews (deduped). */
export function dispatchPendingAiReviews(projectId: string, runId: string): string[] {
  const tasks = listProjectTasks(projectId);
  const pending = tasks.filter((t) => isAiReviewPending(t));
  if (!pending.length) return [];

  if (!isModelConfigured()) {
    const key = `${runId}:no-model`;
    if (!modelMissingNotified.has(key)) {
      modelMissingNotified.add(key);
      appendRunMessage(
        runId,
        'system',
        '未配置 ZAI_API_KEY，無法執行 AI 復查；任務仍維持待 AI 復查。請配置後點「推進一步」重試。',
      );
    }
    return [];
  }

  const started: string[] = [];
  const now = Date.now();

  for (const task of pending) {
    if (reviewingTaskIds.has(task.id)) continue;
    const coolUntil = reviewCooldownUntil.get(task.id) ?? 0;
    if (now < coolUntil) continue;
    reviewingTaskIds.add(task.id);
    started.push(task.id);
    void runOneAiReview(projectId, runId, task.id).finally(() => {
      reviewingTaskIds.delete(task.id);
    });
  }

  return started;
}

export function countPendingAiReviews(projectId: string): number {
  return listProjectTasks(projectId).filter((t) => isAiReviewPending(t)).length;
}

export function isAiReviewInFlight(taskId: string): boolean {
  return reviewingTaskIds.has(taskId);
}
