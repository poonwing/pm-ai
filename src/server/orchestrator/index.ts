import { v4 as uuidv4 } from 'uuid';
import {
  appendRunMessage,
  createAutoRun,
  createDecision,
  createMeeting,
  getAutoRun,
  getAutoRunMessages,
  getReviewPolicy,
  listDecisions,
  resolveDecision,
  stopAutoRun,
  updateAutoRun,
  upsertReviewPolicy,
  type DecisionOption,
} from '../services/auto.js';
import { CUSTOM_DECISION_OPTION_ID } from '../../shared/schemas.js';
import {
  createStaffAgent,
  ensureDefaultStaffAgents,
  listStaffAgents,
  updateStaffAgent,
} from '../services/agents.js';
import {
  createTask,
  getInbox,
  getProject,
  getTask,
  listProjectTasks,
  updateProject,
  ValidationError,
} from '../services/tasks.js';
import { chatCompletion, isModelConfigured } from './model.js';
import { dispatchPendingAiReviews } from './ai-review.js';
import { isPendingReview, type ReviewPolicy } from '../../shared/schemas.js';
import {
  RESEARCH_ACCEPTANCE,
  RESEARCH_CONSTRAINTS,
  collectWorkspaceBrief,
  summarizeResearchForGoal,
} from './research.js';
import { getRunnerStatus, isRunnerConfigured } from '../runner/index.js';

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

interface PlanTask {
  title: string;
  goal: string;
  acceptance_criteria: string;
  role: string;
  queue_order: number;
  reviewer_type: 'human' | 'agent' | 'orchestrator' | 'none';
}

interface OrchestratorPlan {
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

interface ClarifyResult {
  reply: string;
  requirements_summary: string;
  updated_goal: string | null;
  ready_to_execute: boolean;
}

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

/** Models often return checklist items as string[]; store as markdown string. */
function coercePlanText(value: unknown): string {
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

function normalizePlan(plan: OrchestratorPlan): OrchestratorPlan {
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

/** Per-run tick mutex: serialize concurrent ticks; never run two planners at once. */
const tickChains = new Map<string, Promise<unknown>>();

export type TickOptions = {
  /** Bypass wait_events guard and run a fresh plan/assign cycle. */
  forceReplan?: boolean;
  /** Skip requirement clarification and proceed to policy/plan. */
  skipClarify?: boolean;
};

type TickResult = {
  run: ReturnType<typeof getAutoRun>;
  messages: ReturnType<typeof getAutoRunMessages>;
  decisions?: ReturnType<typeof listDecisions>;
  tasks?: string[];
};

function isWaitingPhase(phase: string): boolean {
  return phase === 'wait_events' || phase === 'synthesize';
}

function isClarifyPhase(phase: string): boolean {
  return phase === 'intake' || phase === 'clarify';
}

function isResearchPhase(phase: string): boolean {
  return phase === 'research';
}

function checkpointFlag(checkpoint: Record<string, unknown> | undefined | null, key: string): boolean {
  return Boolean(checkpoint && checkpoint[key] === true);
}

function researchReportFromCheckpoint(
  checkpoint: Record<string, unknown> | undefined | null,
): string {
  if (!checkpoint) return '';
  const report = checkpoint.research_report;
  return typeof report === 'string' ? report.trim() : '';
}

function isClarified(checkpoint: Record<string, unknown> | undefined | null): boolean {
  return Boolean(checkpoint && checkpoint.clarified === true);
}

/** User explicitly asks to stop clarifying and start execution. */
function isStartWorkRequest(message: string): boolean {
  const t = message.trim();
  if (/^\/(start|go|run|execute)\b/i.test(t)) return true;
  return /開始工作|开始工作|立刻開工|立刻开工|馬上開始|马上开始|立即開始|立即开始|可以開工|可以开工|開工吧|开工吧|直接開始|直接开始|開始執行|开始执行|直接幹|直接干|別問了|别问了|夠了.*開始|够了.*开始/.test(
    t,
  );
}

/** Explicit user intent to re-plan while tasks are already running. */
function isExplicitReplanRequest(message: string): boolean {
  const t = message.trim();
  if (/^\/(replan|plan|tick)\b/i.test(t)) return true;
  return /重新規劃|重新计划|再規劃|再计划|重新分派|再分派/.test(t);
}

type ParsedDecisionReply = { optionId: string; note?: string };

/**
 * Optional chat-based decision. Returns null if the message is only a note
 * (user still uses the decision panel).
 */
function tryParseDecisionReply(
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

  // "/decide …" that didn't match: don't treat as free-form note-only silently
  if (cmd) return null;

  return null;
}

function decisionChatHint(options: DecisionOption[]): string {
  const preset = options.filter((o) => o.id !== CUSTOM_DECISION_OPTION_ID);
  const lines = preset.map((o, i) => `${i + 1}. ${o.label}`);
  return [
    '已記下你的補充（尚未決策）。也可直接在對話框決策：',
    ...lines,
    '回覆序號（如 1）、選項原文，或「自訂：你的決定」。下方按鈕同樣可用。',
  ].join('\n');
}

function runResult(runId: string, extra?: Partial<TickResult>): TickResult {
  return {
    run: getAutoRun(runId),
    messages: getAutoRunMessages(runId),
    ...extra,
  };
}

async function buildClarify(
  projectName: string,
  projectDesc: string,
  goal: string,
  history: Array<{ role: string; content: string }>,
  researchReport: string,
): Promise<ClarifyResult> {
  if (!isModelConfigured()) {
    const userTurns = history.filter((m) => m.role === 'user').length;
    if (userTurns <= 1) {
      const known = [
        projectDesc ? `專案描述：${projectDesc}` : '',
        researchReport ? `研究摘要已備妥（見系統研究報告）。` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        reply: [
          `收到目標「${goal}」。${known ? `\n${known}\n` : ''}`,
          '開工前想先對齊需求（已知專案現況的問題請勿重複問）：',
          '1. 成功長什麼樣？有沒有必須達成的驗收標準？',
          '2. 範圍邊界：明確不做什麼？',
          '3. 技術/期限/依賴上有沒有硬約束？',
          '',
          '請先補充你知道的部分。若要跳過對齊直接開工，回覆「開始工作」。',
        ].join('\n'),
        requirements_summary: goal,
        updated_goal: null,
        ready_to_execute: false,
      };
    }
    return {
      reply: [
        '已記下你的補充。若還有細節請繼續說；',
        '若你認為需求夠清楚、可以開工，請回覆「開始工作」。',
      ].join(''),
      requirements_summary: goal,
      updated_goal: null,
      ready_to_execute: userTurns >= 3,
    };
  }

  const system = `你是 PM-AI 專案協調者，正在「需求澄清」階段，還沒有開始規劃或分派任務。
專案名稱：${projectName}
專案描述：${projectDesc || '（無）'}
初始目標：${goal}

${
  researchReport
    ? `研究員已提供 workspace 研究報告（請視為已知事實，不要再問「專案是什麼類型」這類已能從報告推知的問題）：\n${researchReport.slice(0, 6000)}`
    : '（尚無研究報告）'
}

規則：
- 目標可能很模糊；用簡短中文多輪追問，一次最多 2～3 個問題。
- 只問報告與描述仍無法確定的缺口（例如這次要優化的具體痛點、不做什麼）。
- 不要規劃員工、任務或技術方案細節；先對齊要做什麼、不做什麼、如何算完成。
- 若資訊已大致足夠，在 reply 末尾明確告知使用者可回覆「開始工作」來開工。
- 除非使用者已表達要立刻開工，否則 ready_to_execute 必須為 false。
- 只輸出 JSON：
{
  "reply": string,
  "requirements_summary": string,
  "updated_goal": string | null,
  "ready_to_execute": boolean
}`;

  const content = await chatCompletion(
    [
      { role: 'system', content: system },
      {
        role: 'user',
        content: history
          .slice(-12)
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n'),
      },
    ],
    { json: true, temperature: 0.4 },
  );

  try {
    const parsed = parseJsonLoose<Partial<ClarifyResult>>(content);
    return {
      reply: String(parsed.reply ?? content).trim() || '請再補充一下需求，或回覆「開始工作」開始執行。',
      requirements_summary: String(parsed.requirements_summary ?? goal).trim() || goal,
      updated_goal: parsed.updated_goal ? String(parsed.updated_goal).trim() : null,
      ready_to_execute: Boolean(parsed.ready_to_execute),
    };
  } catch {
    return {
      reply: content.trim() || '請再補充一下需求，或回覆「開始工作」開始執行。',
      requirements_summary: goal,
      updated_goal: null,
      ready_to_execute: false,
    };
  }
}

async function runIntakeClarify(runId: string): Promise<TickResult> {
  const run = getAutoRun(runId);
  const project = getProject(run.project_id);
  const history = getAutoRunMessages(runId);
  const result = await buildClarify(
    project.name,
    project.description ?? '',
    run.goal,
    history,
    researchReportFromCheckpoint(run.checkpoint),
  );

  let reply = result.reply;
  if (result.ready_to_execute && !/開始工作|开始工作/.test(reply)) {
    reply += '\n\n若以上理解無誤，請回覆「開始工作」開始執行；若要修正請直接補充。';
  }

  appendRunMessage(runId, 'assistant', reply);
  updateAutoRun(runId, {
    status: 'awaiting_human',
    phase: 'clarify',
    ...(result.updated_goal ? { goal: result.updated_goal } : {}),
    checkpoint: {
      ...run.checkpoint,
      clarified: false,
      requirements_summary: result.requirements_summary,
      ready_to_execute: result.ready_to_execute,
    },
  });
  return runResult(runId);
}

function markClarifiedAndContinue(runId: string, note?: string) {
  const run = getAutoRun(runId);
  if (note) {
    appendRunMessage(runId, 'assistant', note);
  }
  updateAutoRun(runId, {
    status: 'running',
    phase: 'agree_review_policy',
    checkpoint: {
      ...run.checkpoint,
      clarified: true,
      clarified_at: new Date().toISOString(),
    },
  });
}

async function finishResearch(
  runId: string,
  report: string,
  source: 'runner' | 'local' | 'fallback',
): Promise<void> {
  const run = getAutoRun(runId);
  const trimmed = report.trim().slice(0, 8000);
  updateAutoRun(runId, {
    status: 'running',
    phase: checkpointFlag(run.checkpoint, 'skip_clarify_after_research')
      ? 'agree_review_policy'
      : 'clarify',
    checkpoint: {
      ...run.checkpoint,
      research_done: true,
      research_source: source,
      research_report: trimmed,
      research_finished_at: new Date().toISOString(),
      ...(checkpointFlag(run.checkpoint, 'skip_clarify_after_research')
        ? { clarified: true, clarified_at: new Date().toISOString() }
        : {}),
    },
  });
  appendRunMessage(
    runId,
    'assistant',
    source === 'runner'
      ? `研究員已完成 workspace 分析，接下來會基於研究結果澄清／規劃。\n\n—— 研究摘要 ——\n${trimmed.slice(0, 2500)}${trimmed.length > 2500 ? '\n…' : ''}`
      : `已完成 workspace 快速研究（${source}），接下來會基於結果澄清／規劃。\n\n—— 研究摘要 ——\n${trimmed.slice(0, 2500)}${trimmed.length > 2500 ? '\n…' : ''}`,
  );
}

/** Ensure research report exists before clarify/plan. Returns a result when still waiting. */
async function ensureResearchBeforeClarify(runId: string): Promise<TickResult | null> {
  const run = getAutoRun(runId);
  if (checkpointFlag(run.checkpoint, 'research_done')) return null;

  const project = getProject(run.project_id);
  ensureDefaultStaffAgents(run.project_id);

  const researchTaskId =
    typeof run.checkpoint.research_task_id === 'string' ? run.checkpoint.research_task_id : null;

  if (researchTaskId) {
    try {
      const task = getTask(run.project_id, researchTaskId);
      if (task.status === 'done') {
        const note = String(task.result_note ?? '').trim();
        const report =
          note ||
          (await summarizeResearchForGoal(
            collectWorkspaceBrief(project.workspacePath),
            run.goal,
            project.name,
            project.description ?? '',
          ));
        await finishResearch(runId, report, note ? 'runner' : 'fallback');
        return null;
      }

      const jobs = getRunnerStatus(run.project_id).jobs.filter((j) => j.taskId === researchTaskId);
      const terminal = jobs.find((j) => j.status === 'failed' || j.status === 'cancelled');
      if (terminal) {
        const brief = collectWorkspaceBrief(project.workspacePath);
        const report = await summarizeResearchForGoal(
          brief,
          run.goal,
          project.name,
          project.description ?? '',
        );
        await finishResearch(
          runId,
          `${report}\n\n（Runner 研究任務 ${terminal.status}：${terminal.error ?? ''}）`,
          'fallback',
        );
        return null;
      }

      updateAutoRun(runId, { phase: 'research', status: 'running' });
      return runResult(runId);
    } catch {
      /* task missing → recreate below */
    }
  }

  // No runner: local brief + optional LLM summary (sync path)
  if (!isRunnerConfigured()) {
    appendRunMessage(
      runId,
      'assistant',
      'Runner 未配置，改以本機快照做快速研究（只讀）…',
    );
    const brief = collectWorkspaceBrief(project.workspacePath);
    const report = await summarizeResearchForGoal(
      brief,
      run.goal,
      project.name,
      project.description ?? '',
    );
    await finishResearch(runId, report, 'local');
    return null;
  }

  const researchers = listStaffAgents(run.project_id, { assignableOnly: true }).filter(
    (a) => a.role === 'researcher',
  );
  const researcher = researchers[0];
  if (!researcher) {
    const brief = collectWorkspaceBrief(project.workspacePath);
    const report = await summarizeResearchForGoal(
      brief,
      run.goal,
      project.name,
      project.description ?? '',
    );
    await finishResearch(runId, report, 'local');
    return null;
  }

  const task = createTask(
    run.project_id,
    {
      title: `研究：${run.goal.slice(0, 48)}`,
      goal: [
        `針對用戶需求做 workspace 只讀分析。`,
        `需求：${run.goal}`,
        project.description ? `專案描述：${project.description}` : '',
        `工作目錄：${project.workspacePath}`,
        `請產出結構化研究報告（見員工人設），供協調者澄清與規劃。`,
      ]
        .filter(Boolean)
        .join('\n'),
      acceptance_criteria: RESEARCH_ACCEPTANCE,
      constraints: RESEARCH_CONSTRAINTS,
      agent_name: 'orchestrator',
      use_isolation: false,
      assignee_agent_id: researcher.id,
      assignee_name: researcher.name,
      queue_order: 0,
      review: {
        required: false,
        reviewer_type: 'none',
        reviewer_agent_id: null,
        status: 'none',
        note: '',
      },
    },
    'agent',
  );

  const { enqueueRunnerJob } = await import('../runner/index.js');
  const job = enqueueRunnerJob({
    projectId: run.project_id,
    taskId: task.id,
    autoRunId: runId,
  });

  if (job.status === 'failed') {
    const brief = collectWorkspaceBrief(project.workspacePath);
    const report = await summarizeResearchForGoal(
      brief,
      run.goal,
      project.name,
      project.description ?? '',
    );
    await finishResearch(
      runId,
      `${report}\n\n（Runner 未能啟動研究任務：${job.error ?? 'unknown'}）`,
      'fallback',
    );
    return null;
  }

  updateAutoRun(runId, {
    phase: 'research',
    status: 'running',
    checkpoint: {
      ...run.checkpoint,
      research_task_id: task.id,
      research_started_at: new Date().toISOString(),
    },
  });
  appendRunMessage(
    runId,
    'assistant',
    `已指派研究員「${researcher.name}」分析 workspace（任務 ${task.id}，只讀）。完成後我會帶著研究結果繼續澄清。`,
  );
  return runResult(runId, { tasks: [task.id] });
}

async function buildPlan(
  projectName: string,
  projectDesc: string,
  goal: string,
  history: Array<{ role: string; content: string }>,
  policy: ReviewPolicy,
  existingStaff: Array<{ name: string; role: string; system_prompt: string }>,
  researchReport: string,
): Promise<OrchestratorPlan> {
  if (!isModelConfigured()) {
    return {
      summary: `離線規劃（未配置模型）：圍繞「${goal}」分派既有開發與測試員工。`,
      staff: [],
      tasks: [
        {
          title: `實現：${goal.slice(0, 40)}`,
          goal,
          acceptance_criteria: '- [ ] 功能可用\n- [ ] 無明顯回歸',
          role: 'developer',
          queue_order: 1,
          reviewer_type: policy.default_reviewer_type,
        },
        {
          title: `測試：${goal.slice(0, 40)}`,
          goal: `驗證 ${goal}`,
          acceptance_criteria: '- [ ] 關鍵路徑通過',
          role: 'tester',
          queue_order: 2,
          reviewer_type: 'human',
        },
      ],
    };
  }

  const staffRoster = existingStaff
    .map((s) => {
      const promptPreview =
        s.system_prompt.length > 160 ? `${s.system_prompt.slice(0, 160)}…` : s.system_prompt;
      return `- ${s.name} (role=${s.role}): ${promptPreview}`;
    })
    .join('\n');

  const system = `你是 PM-AI 專案協調者。根據專案與用戶目標輸出 JSON 計劃（不要 markdown 說明）。
專案：${projectName}
描述：${projectDesc || '（無）'}
預設審查：${policy.default_reviewer_type}

${
  researchReport
    ? `研究員 workspace 報告（規劃時請尊重現況，避免重寫整個專案）：\n${researchReport.slice(0, 5000)}`
    : '（無研究報告）'
}

專案已有固定可分派員工（優先使用，不要重複建立同 role；researcher 通常不必再派實作任務）：
${staffRoster || '（尚無）'}

規則：
- tasks.role 必須對應上列既有 role，或你在 staff 裡擬新增的非常規 role
- staff 陣列僅用於：(1) 依本目標微調既有角色的 system_prompt；(2) 缺職能時新增非常規角色
- 不需要調整提示詞時 staff 可為 []
- 不要再建立「研究／探勘」任務（研究已完成）
- 常用既有 role：analyst / designer / developer / tester / reviewer

JSON schema:
{
  "summary": string,
  "staff": [{"name","role","system_prompt","skills_tags":string[]}],
  "tasks": [{"title":string,"goal":string,"acceptance_criteria":string,"role":string,"queue_order":number,"reviewer_type":string}],
  "need_decision": boolean,
  "decision": {"title","summary","options":[{"id","label","description"}],"recommended_option_id"} | null,
  "need_meeting": boolean,
  "meeting_topic": string | null
}
注意：acceptance_criteria 必須是單一字串（可用 \\n 分隔 checklist），不要回傳陣列。`;

  const userParts = [
    `目標：${goal}`,
    ...history.slice(-8).map((m) => `${m.role}: ${m.content}`),
  ];

  const content = await chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: userParts.join('\n') },
    ],
    { json: true, temperature: 0.3 },
  );
  return normalizePlan(parseJsonLoose<OrchestratorPlan>(content));
}

export async function startOrchestratorRun(projectId: string, goal: string) {
  ensureDefaultStaffAgents(projectId);
  updateProject(projectId, { run_mode: 'auto' });
  const run = createAutoRun(projectId, goal);
  if (isStartWorkRequest(goal)) {
    updateAutoRun(run.id, {
      checkpoint: {
        ...run.checkpoint,
        skip_clarify_after_research: true,
      },
    });
    appendRunMessage(
      run.id,
      'assistant',
      '偵測到你要求立刻開工：先做 workspace 研究，完成後將跳過需求澄清，進入審查協定與規劃。',
    );
    return tickOrchestrator(run.id, { skipClarify: true });
  }
  return tickOrchestrator(run.id);
}

export async function messageOrchestrator(runId: string, message: string) {
  const run = getAutoRun(runId);
  if (run.status === 'stopped' || run.status === 'completed') {
    throw new ValidationError('Run 已結束');
  }
  appendRunMessage(runId, 'user', message);
  if (run.status === 'paused') {
    updateAutoRun(runId, { status: 'running' });
  }

  let latest = getAutoRun(runId);
  const open = listDecisions(latest.project_id, 'open').filter((d) => d.run_id === runId);

  if (open.length) {
    const decision = [...open].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    const parsed = tryParseDecisionReply(decision.options, message);
    if (parsed) {
      resolveDecision(decision.id, parsed.optionId, parsed.note);
      appendRunMessage(runId, 'assistant', `已依對話完成決策「${decision.title}」，繼續推進。`);
      if (decision.title.includes('Review Policy')) {
        return handlePolicyDecision(decision.id, parsed.optionId);
      }
      return tickOrchestrator(runId);
    }
    appendRunMessage(runId, 'assistant', decisionChatHint(decision.options));
    return runResult(runId, { decisions: open });
  }

  latest = getAutoRun(runId);

  if (
    isResearchPhase(latest.phase) ||
    (!checkpointFlag(latest.checkpoint, 'research_done') &&
      typeof latest.checkpoint.research_task_id === 'string')
  ) {
    if (isStartWorkRequest(message)) {
      updateAutoRun(runId, {
        checkpoint: {
          ...latest.checkpoint,
          skip_clarify_after_research: true,
        },
      });
      appendRunMessage(
        runId,
        'assistant',
        '已記下。研究員完成後將跳過澄清，直接進入審查協定與規劃。',
      );
    } else {
      appendRunMessage(
        runId,
        'assistant',
        '研究員仍在分析 workspace，已記下你的補充；研究完成後會一併納入澄清／規劃。',
      );
    }
    return tickOrchestrator(runId, {
      skipClarify: checkpointFlag(getAutoRun(runId).checkpoint, 'skip_clarify_after_research'),
    });
  }

  if (!isClarified(latest.checkpoint) && isClarifyPhase(latest.phase)) {
    if (isStartWorkRequest(message)) {
      markClarifiedAndContinue(runId, '需求對齊結束，開始進入審查協定與規劃…');
      return tickOrchestrator(runId, { skipClarify: true });
    }
    return runIntakeClarify(runId);
  }

  if (isWaitingPhase(latest.phase)) {
    if (isExplicitReplanRequest(message)) {
      appendRunMessage(runId, 'assistant', '收到，將依你的補充重新規劃與分派…');
      return tickOrchestrator(runId, { forceReplan: true });
    }
    appendRunMessage(
      runId,
      'assistant',
      '已記下補充指示（任務仍在執行中，不會自動重規劃）。若要依新指示重新規劃，請回覆「重新規劃」，或點「推進一步」查看進度彙總。',
    );
    return runResult(runId);
  }

  return tickOrchestrator(runId);
}

export async function onDecisionResolved(decisionId: string) {
  const { getDecision } = await import('../services/auto.js');
  const d = getDecision(decisionId);
  if (d.run_id) {
    appendRunMessage(
      d.run_id,
      'system',
      `人類已選擇決策「${d.title}」選項：${d.chosen_option_id}`,
    );
    return tickOrchestrator(d.run_id);
  }
  return null;
}

export async function onTaskEvent(projectId: string, taskId: string, event: string) {
  const runs = (await import('../services/auto.js')).listAutoRuns(projectId);
  const active = runs.find((r) => r.status === 'running' || r.status === 'awaiting_human');
  if (!active) return null;
  appendRunMessage(active.id, 'system', `任務事件 ${taskId}: ${event}`);
  if (active.status === 'running') {
    return tickOrchestrator(active.id);
  }
  return active;
}

export async function tickOrchestrator(
  runId: string,
  opts: TickOptions = {},
): Promise<TickResult> {
  const prev = tickChains.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  tickChains.set(runId, chained);

  try {
    await prev.catch(() => undefined);
    return await tickOrchestratorUnlocked(runId, opts);
  } finally {
    release();
    if (tickChains.get(runId) === chained) {
      tickChains.delete(runId);
    }
  }
}

async function tickOrchestratorUnlocked(
  runId: string,
  opts: TickOptions = {},
): Promise<TickResult> {
  const run = getAutoRun(runId);
  if (run.status === 'stopped' || run.status === 'paused' || run.status === 'completed') {
    return { run, messages: getAutoRunMessages(runId) };
  }

  const project = getProject(run.project_id);
  ensureDefaultStaffAgents(run.project_id);
  const history = getAutoRunMessages(runId);

  // Interrupt if open decisions
  const open = listDecisions(run.project_id, 'open').filter((d) => d.run_id === runId);
  if (open.length) {
    updateAutoRun(runId, { status: 'awaiting_human', phase: 'decision' });
    return { run: getAutoRun(runId), messages: history, decisions: open };
  }

  // Already assigned: dispatch AI reviews + synthesize unless forceReplan
  if (isWaitingPhase(run.phase) && !opts.forceReplan) {
    const started = dispatchPendingAiReviews(run.project_id, runId);
    if (started.length) {
      appendRunMessage(
        runId,
        'system',
        `已啟動 AI 復查：${started.join(', ')}`,
      );
    }
    synthesizeProgress(run.project_id, runId);
    return runResult(runId);
  }

  // Workspace research before clarify / policy / plan (keep report on forceReplan)
  if (!checkpointFlag(run.checkpoint, 'research_done')) {
    const waiting = await ensureResearchBeforeClarify(runId);
    if (waiting) return waiting;
  }

  let latestRun = getAutoRun(runId);
  const skipClarify =
    opts.skipClarify ||
    checkpointFlag(latestRun.checkpoint, 'skip_clarify_after_research') ||
    isClarified(latestRun.checkpoint);

  // Requirement clarification before any policy/plan work
  if (!skipClarify && !opts.forceReplan && isClarifyPhase(latestRun.phase)) {
    return runIntakeClarify(runId);
  }

  // After research with skip flag, phase may still be clarify — advance
  if (
    skipClarify &&
    !isClarified(latestRun.checkpoint) &&
    (isClarifyPhase(latestRun.phase) || isResearchPhase(latestRun.phase))
  ) {
    markClarifiedAndContinue(runId);
    latestRun = getAutoRun(runId);
  }

  const policyNow = getReviewPolicy(latestRun.project_id);
  if (!policyNow.confirmed) {
    const draft = upsertReviewPolicy(
      latestRun.project_id,
      {
        default_reviewer_type: 'human',
        human_verify_notes: `針對目標「${latestRun.goal}」：核心交付需人類驗收；細節可由 AI reviewer 先查。`,
        confirmed: false,
      },
      false,
    );
    appendRunMessage(
      runId,
      'assistant',
      `請先確認審查協定（Review Policy）：預設審查者=${draft.default_reviewer_type}。確認後我會繼續規劃與分派。`,
    );
    createDecision({
      projectId: latestRun.project_id,
      runId,
      title: '確認 Review Policy',
      summary: draft.human_verify_notes,
      options: [
        { id: 'confirm', label: '確認預設協定並繼續' },
        {
          id: 'agent_default',
          label: '預設由 AI agent 審查',
          description: 'default_reviewer_type=agent',
        },
        {
          id: 'human_only',
          label: '全部由人類驗收',
          description: 'default_reviewer_type=human',
        },
      ],
      recommendedOptionId: 'confirm',
    });
    updateAutoRun(runId, {
      status: 'awaiting_human',
      phase: 'agree_review_policy',
      checkpoint: { ...latestRun.checkpoint, clarified: true, policy_draft: draft },
    });
    return {
      run: getAutoRun(runId),
      messages: getAutoRunMessages(runId),
      decisions: listDecisions(latestRun.project_id, 'open'),
    };
  }

  // If phase is agree_review_policy and somehow no open decision, mark confirmed via last choice handled in resolve hook
  if (latestRun.phase === 'agree_review_policy') {
    upsertReviewPolicy(latestRun.project_id, { confirmed: true }, true);
  }

  updateAutoRun(runId, { phase: 'plan', status: 'running' });
  appendRunMessage(runId, 'assistant', '正在規劃任務分派…');

  const roster = listStaffAgents(latestRun.project_id, { assignableOnly: true });
  const plan = await buildPlan(
    project.name,
    project.description ?? '',
    latestRun.goal,
    history,
    getReviewPolicy(latestRun.project_id),
    roster.map((s) => ({
      name: s.name,
      role: s.role,
      system_prompt: s.system_prompt,
    })),
    researchReportFromCheckpoint(latestRun.checkpoint),
  );

  appendRunMessage(runId, 'assistant', plan.summary || '計劃已生成');

  if (plan.need_decision && plan.decision) {
    createDecision({
      projectId: run.project_id,
      runId,
      title: plan.decision.title,
      summary: plan.decision.summary,
      options: plan.decision.options.map((o) => ({
        id: o.id || uuidv4(),
        label: o.label,
        description: o.description,
      })),
      recommendedOptionId: plan.decision.recommended_option_id ?? null,
    });
    appendRunMessage(runId, 'assistant', `需要你決策：${plan.decision.title}`);
    updateAutoRun(runId, { status: 'awaiting_human', phase: 'decision' });
    return {
      run: getAutoRun(runId),
      messages: getAutoRunMessages(runId),
      decisions: listDecisions(run.project_id, 'open'),
    };
  }

  if (plan.need_meeting && plan.meeting_topic) {
    const staff = listStaffAgents(run.project_id, { assignableOnly: true });
    const participants = staff.slice(0, 3);
    const messages = [];
    for (const s of participants) {
      let content = `從 ${s.role} 角度：建議推進「${run.goal}」。`;
      if (isModelConfigured()) {
        try {
          content = await chatCompletion([
            { role: 'system', content: s.system_prompt },
            {
              role: 'user',
              content: `會議主題：${plan.meeting_topic}\n專案目標：${run.goal}\n請用 2-4 句給出專業意見。`,
            },
          ]);
        } catch {
          /* keep fallback */
        }
      }
      messages.push({
        agentId: s.id,
        agentName: s.name,
        role: s.role,
        content,
      });
    }
    const meeting = createMeeting({
      projectId: run.project_id,
      runId,
      topic: plan.meeting_topic,
      participantIds: participants.map((p) => p.id),
      messages,
      summary: `會議「${plan.meeting_topic}」結束，繼續執行計劃。`,
    });
    appendRunMessage(runId, 'assistant', `已召開會議：${meeting.topic}`);
  }

  updateAutoRun(runId, { phase: 'ensure_staff' });
  ensureDefaultStaffAgents(run.project_id);
  const existing = listStaffAgents(run.project_id);
  const byRole = new Map(
    existing
      .filter((e) => e.assignable && e.status !== 'retired' && e.role !== 'orchestrator')
      .map((e) => [e.role, e]),
  );

  for (const s of plan.staff ?? []) {
    if (s.role === 'orchestrator') continue;
    const current = byRole.get(s.role);
    if (current) {
      const nextPrompt = (s.system_prompt ?? '').trim();
      if (nextPrompt && nextPrompt !== current.system_prompt.trim()) {
        const updated = updateStaffAgent(
          current.id,
          {
            system_prompt: nextPrompt,
            ...(s.skills_tags?.length ? { skills_tags: s.skills_tags } : {}),
            ...(s.name?.trim() ? { name: s.name.trim() } : {}),
          },
          'orchestrator',
        );
        byRole.set(s.role, updated as never);
        appendRunMessage(
          runId,
          'assistant',
          `已依目標調整 ${updated.name}（${updated.role}）提示詞`,
        );
      }
      continue;
    }
    const created = createStaffAgent(
      run.project_id,
      {
        name: s.name,
        role: s.role,
        system_prompt: s.system_prompt,
        skills_tags: s.skills_tags ?? [],
        assignable: true,
        creation_rationale: `協調者依目標「${run.goal}」新增非常規角色`,
      },
      'orchestrator',
    );
    byRole.set(s.role, created as never);
    appendRunMessage(runId, 'assistant', `已建立員工 ${created.name}（${created.role}）`);
  }

  updateAutoRun(runId, { phase: 'assign' });
  const assignable = listStaffAgents(run.project_id, { assignableOnly: true });
  const roleMap = new Map(assignable.map((a) => [a.role, a]));

  const createdTaskIds: string[] = [];
  for (const t of plan.tasks ?? []) {
    const assignee = roleMap.get(t.role) ?? assignable[0];
    if (!assignee) {
      appendRunMessage(runId, 'assistant', `無可用 assignable 員工，跳過任務：${t.title}`);
      continue;
    }
    const task = createTask(
      run.project_id,
      {
        title: t.title,
        goal: t.goal,
        acceptance_criteria: t.acceptance_criteria,
        agent_name: 'orchestrator',
        use_isolation: Boolean(project.gitRoot),
        assignee_agent_id: assignee.id,
        assignee_name: assignee.name,
        queue_order: t.queue_order,
        review: {
          required: t.reviewer_type !== 'none',
          reviewer_type: t.reviewer_type,
          reviewer_agent_id:
            t.reviewer_type === 'agent'
              ? (roleMap.get('reviewer')?.id ?? null)
              : null,
          status: 'none',
          note: '',
        },
      },
      'agent',
    );
    createdTaskIds.push(task.id);
    appendRunMessage(
      runId,
      'assistant',
      `已分派 ${task.id} → ${assignee.name}（序 ${t.queue_order}）` +
        (t.reviewer_type === 'agent'
          ? `，審查者 ${roleMap.get('reviewer')?.name ?? '協調者備援'}`
          : t.reviewer_type === 'orchestrator'
            ? '，由協調者復查'
            : ''),
    );
    const { enqueueRunnerJob } = await import('../runner/index.js');
    enqueueRunnerJob({
      projectId: run.project_id,
      taskId: task.id,
      autoRunId: runId,
    });
  }

  updateAutoRun(runId, {
    phase: 'wait_events',
    status: 'running',
    checkpoint: {
      ...run.checkpoint,
      plan,
      created_task_ids: createdTaskIds,
    },
  });
  appendRunMessage(
    runId,
    'assistant',
    createdTaskIds.length
      ? `已建立 ${createdTaskIds.length} 個任務，並提交 Runner（${process.env.RUNNER_PROVIDER ?? 'cursor'}）自動執行。完成後我會彙總；你也可隨時喊停。`
      : '尚未建立任務。請補充需求或確認有 assignable 員工。',
  );

  // If no tasks and no more work, complete
  if (!createdTaskIds.length && !(plan.tasks?.length)) {
    updateAutoRun(runId, { status: 'completed', phase: 'completed' });
  }

  return {
    run: getAutoRun(runId),
    messages: getAutoRunMessages(runId),
    tasks: createdTaskIds,
  };
}

export async function handlePolicyDecision(decisionId: string, chosenOptionId: string) {
  const { getDecision } = await import('../services/auto.js');
  const d = getDecision(decisionId);
  if (d.title.includes('Review Policy') && d.run_id) {
    if (chosenOptionId === 'human_only') {
      upsertReviewPolicy(
        d.project_id,
        { default_reviewer_type: 'human', human_verify_paths: ['**'] },
        true,
      );
    } else if (chosenOptionId === 'agent_default') {
      upsertReviewPolicy(d.project_id, { default_reviewer_type: 'agent' }, true);
    } else if (chosenOptionId === 'custom') {
      upsertReviewPolicy(
        d.project_id,
        {
          ...(d.note?.trim() ? { human_verify_notes: d.note.trim() } : {}),
          confirmed: true,
        },
        true,
      );
    } else {
      upsertReviewPolicy(d.project_id, {}, true);
    }
    updateAutoRun(d.run_id, { phase: 'plan', status: 'running' });
  }
  return tickOrchestrator(d.run_id!);
}

export function requestStop(runId: string) {
  const run = stopAutoRun(runId);
  appendRunMessage(runId, 'system', '人類已停止 Auto Run');
  void import('../runner/index.js').then((m) => m.cancelForAutoRun(runId));
  return run;
}

export function synthesizeProgress(projectId: string, runId: string) {
  const tasks = listProjectTasks(projectId);
  const inbox = getInbox().filter((t) => t.projectId === projectId || t.project_id === projectId);
  const done = tasks.filter((t) => t.status === 'done');
  const pendingReview = done.filter((t) =>
    isPendingReview(t as Parameters<typeof isPendingReview>[0]),
  );
  const pendingAi = pendingReview.filter(
    (t) => t.review?.reviewer_type === 'agent' || t.review?.reviewer_type === 'orchestrator',
  );
  const pendingHuman = pendingReview.filter(
    (t) => !t.review || t.review.reviewer_type === 'human',
  );
  const summary = `進度：共 ${tasks.length} 任務，完成 ${done.length}，待 AI 復查 ${pendingAi.length}，待人驗收 ${pendingHuman.length}，inbox ${inbox.length}`;
  appendRunMessage(runId, 'assistant', summary);
  if (tasks.length && done.length === tasks.length && pendingReview.length === 0) {
    updateAutoRun(runId, { status: 'completed', phase: 'completed' });
  }
  return getAutoRun(runId);
}
