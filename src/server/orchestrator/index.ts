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
  ensureOrchestratorAgent,
  listStaffAgents,
} from '../services/agents.js';
import {
  createTask,
  getInbox,
  getProject,
  listProjectTasks,
  updateProject,
  ValidationError,
} from '../services/tasks.js';
import { chatCompletion, isModelConfigured } from './model.js';
import { dispatchPendingAiReviews } from './ai-review.js';
import { isPendingReview, type ReviewPolicy } from '../../shared/schemas.js';

export type OrchestratorPhase =
  | 'intake'
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
  goal: string,
  history: Array<{ role: string; content: string }>,
): Promise<ClarifyResult> {
  if (!isModelConfigured()) {
    const userTurns = history.filter((m) => m.role === 'user').length;
    if (userTurns <= 1) {
      return {
        reply: [
          `收到目標「${goal}」。開工前想先對齊需求（模糊也可以，我們慢慢補）：`,
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
專案：${projectName}
初始目標：${goal}

規則：
- 目標可能很模糊；用簡短中文多輪追問，一次最多 2～3 個問題。
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
  const result = await buildClarify(project.name, run.goal, history);

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

async function buildPlan(
  projectName: string,
  projectDesc: string,
  goal: string,
  history: Array<{ role: string; content: string }>,
  policy: ReviewPolicy,
): Promise<OrchestratorPlan> {
  if (!isModelConfigured()) {
    return {
      summary: `離線規劃（未配置 GLM）：圍繞「${goal}」建立基礎開發與測試員工與任務。`,
      staff: [
        {
          name: '開發者',
          role: 'developer',
          system_prompt: `你是 ${projectName} 的開發者。目標：${goal}。只在 execution_path 改代碼，完成前 commit。`,
          skills_tags: ['code'],
        },
        {
          name: '測試者',
          role: 'tester',
          system_prompt: `你是 ${projectName} 的測試者。驗證：${goal}。`,
          skills_tags: ['test'],
        },
      ],
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

  const system = `你是 PM-AI 專案協調者。根據專案與用戶目標輸出 JSON 計劃（不要 markdown 說明）。
專案：${projectName}
描述：${projectDesc || '（無）'}
預設審查：${policy.default_reviewer_type}
JSON schema:
{
  "summary": string,
  "staff": [{"name","role","system_prompt","skills_tags":string[]}],
  "tasks": [{"title","goal","acceptance_criteria","role","queue_order","reviewer_type"}],
  "need_decision": boolean,
  "decision": {"title","summary","options":[{"id","label","description"}],"recommended_option_id"} | null,
  "need_meeting": boolean,
  "meeting_topic": string | null
}
role 常用：developer/tester/designer/reviewer。tasks.role 須對應 staff.role。`;

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
  return parseJsonLoose<OrchestratorPlan>(content);
}

export async function startOrchestratorRun(projectId: string, goal: string) {
  ensureOrchestratorAgent(projectId);
  updateProject(projectId, { run_mode: 'auto' });
  const run = createAutoRun(projectId, goal);
  if (isStartWorkRequest(goal)) {
    markClarifiedAndContinue(
      run.id,
      '偵測到你要求立刻開工，將跳過需求澄清，進入審查協定與規劃。',
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
  ensureOrchestratorAgent(run.project_id);
  const policy = getReviewPolicy(run.project_id);
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

  // Requirement clarification before any policy/plan work
  if (
    !isClarified(run.checkpoint) &&
    !opts.skipClarify &&
    !opts.forceReplan &&
    isClarifyPhase(run.phase)
  ) {
    return runIntakeClarify(runId);
  }

  if (!policy.confirmed) {
    const draft = upsertReviewPolicy(
      run.project_id,
      {
        default_reviewer_type: 'human',
        human_verify_notes: `針對目標「${run.goal}」：核心交付需人類驗收；細節可由 AI reviewer 先查。`,
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
      projectId: run.project_id,
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
      checkpoint: { ...run.checkpoint, clarified: true, policy_draft: draft },
    });
    return {
      run: getAutoRun(runId),
      messages: getAutoRunMessages(runId),
      decisions: listDecisions(run.project_id, 'open'),
    };
  }

  // If phase is agree_review_policy and somehow no open decision, mark confirmed via last choice handled in resolve hook
  if (run.phase === 'agree_review_policy') {
    upsertReviewPolicy(run.project_id, { confirmed: true }, true);
  }

  updateAutoRun(runId, { phase: 'plan', status: 'running' });
  appendRunMessage(runId, 'assistant', '正在規劃員工與任務…');

  const plan = await buildPlan(
    project.name,
    project.description ?? '',
    run.goal,
    history,
    getReviewPolicy(run.project_id),
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
  const existing = listStaffAgents(run.project_id);
  const byRole = new Map(existing.filter((e) => e.assignable).map((e) => [e.role, e]));

  for (const s of plan.staff ?? []) {
    if (s.role === 'orchestrator') continue;
    if (byRole.has(s.role)) continue;
    const created = createStaffAgent(
      run.project_id,
      {
        name: s.name,
        role: s.role,
        system_prompt: s.system_prompt,
        skills_tags: s.skills_tags ?? [],
        assignable: true,
        creation_rationale: `協調者依目標「${run.goal}」建立`,
      },
      'orchestrator',
    );
    byRole.set(s.role, created as never);
    appendRunMessage(runId, 'assistant', `已建立員工 ${created.name}（${created.role}）`);
  }

  const needsAgentReviewer =
    (plan.tasks ?? []).some((t) => t.reviewer_type === 'agent') ||
    getReviewPolicy(run.project_id).default_reviewer_type === 'agent';
  if (needsAgentReviewer && !byRole.has('reviewer')) {
    const created = createStaffAgent(
      run.project_id,
      {
        name: 'Reviewer',
        role: 'reviewer',
        system_prompt:
          '你是嚴格的程式碼審查者。對照驗收標準檢查交付是否完整、正確、可維護；不通過就明確指出問題。',
        skills_tags: ['review'],
        assignable: true,
        creation_rationale: '協調者為 AI 復查自動建立 reviewer',
      },
      'orchestrator',
    );
    byRole.set('reviewer', created as never);
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
