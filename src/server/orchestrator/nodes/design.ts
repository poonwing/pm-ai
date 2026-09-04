import { interrupt } from '@langchain/langgraph';
import { appendRunMessage, getAutoRunMessages } from '../../services/auto.js';
import { getProject } from '../../services/tasks.js';
import { chatCompletion, isModelConfigured } from '../model.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';
import {
  DESIGN_STAGE_LABELS,
  DESIGN_STAGE_ORDER,
  designFromCheckpoint,
  emptyDesignCheckpoint,
  isConfirmDesignRequest,
  isDesignDone,
  nextDesignStage,
  parseJsonLoose,
  researchReportFromCheckpoint,
  rollbackDesignTo,
  type DesignCheckpoint,
  type DesignStage,
} from '../helpers.js';

interface DesignTurnResult {
  reply: string;
  artifact: string | null;
  skip_remaining: DesignStage[];
  rollback_to: DesignStage | null;
  ready_to_confirm: boolean;
  skip_current: boolean;
}

function defaultArtifact(stage: DesignStage, goal: string): string {
  switch (stage) {
    case 'system':
      return [
        `## 高層架構（草案）`,
        `- 目標：${goal}`,
        `- 建議技術棧：依現有專案為準；新專案優先 TypeScript + 既有框架`,
        `- 模組邊界：協調者 / 執行 Runner / 資料持久層`,
        ``,
        `請確認或補充技術約束；確認後回覆「確認設計」。`,
      ].join('\n');
    case 'data':
      return [
        `## 資料設計（草案）`,
        `- 主要實體：依需求釐清後列出`,
        `- 持久化：專案既有儲存（SQLite / 檔案）優先`,
        ``,
        `確認後回覆「確認設計」。`,
      ].join('\n');
    case 'coding':
      return [
        `## 編碼設計（草案）`,
        `- 模組切分與關鍵介面`,
        `- 測試策略：關鍵路徑手動 / 自動化依任務決定`,
        ``,
        `確認後回覆「確認設計」。`,
      ].join('\n');
    case 'ui':
      return [
        `## UI 設計（草案）`,
        `- 主要畫面與流程`,
        `- 與現有 UI 組件風格一致`,
        ``,
        `確認後回覆「確認設計」以完成設計階段。`,
      ].join('\n');
  }
}

async function buildDesignTurn(input: {
  projectName: string;
  projectDesc: string;
  goal: string;
  stage: DesignStage;
  design: DesignCheckpoint;
  history: Array<{ role: string; content: string }>;
  researchReport: string;
  requirementsSummary: string;
}): Promise<DesignTurnResult> {
  const { stage, goal, design } = input;

  if (!isModelConfigured()) {
    const existing = design.artifacts[stage]?.trim();
    return {
      reply: existing
        ? `【${DESIGN_STAGE_LABELS[stage]}】請檢視下方草案並回覆「確認設計」；若要修改請直接說明。\n\n${existing}`
        : `【${DESIGN_STAGE_LABELS[stage]}】\n\n${defaultArtifact(stage, goal)}`,
      artifact: existing || defaultArtifact(stage, goal),
      skip_remaining: [],
      rollback_to: null,
      ready_to_confirm: true,
      skip_current: false,
    };
  }

  const prior = DESIGN_STAGE_ORDER.filter(
    (s) => s !== stage && (design.artifacts[s] || design.skipped.includes(s)),
  )
    .map((s) => {
      if (design.skipped.includes(s)) return `### ${DESIGN_STAGE_LABELS[s]}\n（已跳過）`;
      return `### ${DESIGN_STAGE_LABELS[s]}\n${design.artifacts[s] ?? ''}`;
    })
    .join('\n\n');

  const system = `你是 PM-AI 專案協調者，正在「設計規劃」階段的子步驟：${DESIGN_STAGE_LABELS[stage]}。
專案：${input.projectName}
描述：${input.projectDesc || '（無）'}
目標：${goal}
需求摘要：${input.requirementsSummary || goal}

${
  input.researchReport
    ? `研究報告摘要：\n${input.researchReport.slice(0, 4000)}`
    : '（無研究報告）'
}

已確認／先前設計：
${prior || '（尚無）'}

規則：
- 用簡短中文與用戶多輪對齊本階段設計；一次最多 2～3 個問題或一個清晰草案。
- 若需求很簡單、本階段／後續階段無必要，可設 skip_current=true 或 skip_remaining 列出可跳過的後續階段（system/data/coding/ui）。
- 若用戶指出更早階段有問題，設 rollback_to 為該階段（system|data|coding|ui）。
- artifact 為本階段設計文檔（markdown 字串），應可給後續分派任務使用。
- 資訊足夠時 ready_to_confirm=true，並在 reply 末尾請用戶回覆「確認設計」。
- 只輸出 JSON：
{
  "reply": string,
  "artifact": string | null,
  "skip_remaining": string[],
  "rollback_to": string | null,
  "ready_to_confirm": boolean,
  "skip_current": boolean
}`;

  const content = await chatCompletion(
    [
      { role: 'system', content: system },
      {
        role: 'user',
        content: input.history
          .slice(-12)
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n'),
      },
    ],
    { json: true, temperature: 0.35 },
  );

  try {
    const parsed = parseJsonLoose<Partial<DesignTurnResult> & { skip_remaining?: unknown }>(
      content,
    );
    const skip_remaining = Array.isArray(parsed.skip_remaining)
      ? parsed.skip_remaining.filter((s): s is DesignStage =>
          DESIGN_STAGE_ORDER.includes(s as DesignStage),
        )
      : [];
    const rollback =
      parsed.rollback_to && DESIGN_STAGE_ORDER.includes(parsed.rollback_to as DesignStage)
        ? (parsed.rollback_to as DesignStage)
        : null;
    return {
      reply:
        String(parsed.reply ?? content).trim() ||
        `請檢視 ${DESIGN_STAGE_LABELS[stage]}，確認後回覆「確認設計」。`,
      artifact: parsed.artifact != null ? String(parsed.artifact).trim() : null,
      skip_remaining,
      rollback_to: rollback,
      ready_to_confirm: Boolean(parsed.ready_to_confirm),
      skip_current: Boolean(parsed.skip_current),
    };
  } catch {
    return {
      reply: content.trim() || `請確認 ${DESIGN_STAGE_LABELS[stage]}，或回覆「確認設計」。`,
      artifact: design.artifacts[stage] ?? defaultArtifact(stage, goal),
      skip_remaining: [],
      rollback_to: null,
      ready_to_confirm: false,
      skip_current: false,
    };
  }
}

function applySkipAndAdvance(
  design: DesignCheckpoint,
  stage: DesignStage,
  result: DesignTurnResult,
): DesignCheckpoint {
  let next: DesignCheckpoint = { ...design, skipped: [...design.skipped] };
  if (result.skip_current && !next.skipped.includes(stage)) {
    next.skipped.push(stage);
    next.confirmed = { ...next.confirmed, [stage]: true };
  }
  for (const s of result.skip_remaining) {
    if (!next.skipped.includes(s) && DESIGN_STAGE_ORDER.indexOf(s) > DESIGN_STAGE_ORDER.indexOf(stage)) {
      next.skipped.push(s);
      next.confirmed = { ...next.confirmed, [s]: true };
    }
  }
  if (result.artifact?.trim()) {
    next.artifacts = { ...next.artifacts, [stage]: result.artifact.trim() };
  }
  return next;
}

function confirmCurrentStage(design: DesignCheckpoint, stage: DesignStage): DesignCheckpoint {
  const confirmed = { ...design.confirmed, [stage]: true };
  const nxt = nextDesignStage(stage, design.skipped);
  return {
    ...design,
    confirmed,
    active_stage: nxt,
    design_done: nxt === 'done',
  };
}

export async function designNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  let design = designFromCheckpoint(state.checkpoint) ?? emptyDesignCheckpoint();
  // Clear redesign latch once we enter the design node.
  const baseCheckpoint = { ...state.checkpoint, force_redesign: false };

  if (design.design_done || design.active_stage === 'done') {
    const checkpoint = {
      ...baseCheckpoint,
      design: { ...design, active_stage: 'done' as const, design_done: true },
      force_redesign: false,
    };
    const next = { ...state, phase: 'plan', status: 'running', checkpoint };
    syncRunMirror(next);
    return { phase: 'plan', status: 'running', checkpoint };
  }

  const stage = design.active_stage as DesignStage;
  const project = getProject(state.projectId);
  const history = getAutoRunMessages(state.runId);
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const pending = state.pendingCommand;
  const userText =
    pending?.type === 'user_message'
      ? pending.text
      : lastUser?.content ?? '';

  // User confirms current stage → advance (or finish).
  if (userText && isConfirmDesignRequest(userText) && design.artifacts[stage]?.trim()) {
    design = confirmCurrentStage(design, stage);
    if (design.design_done || design.active_stage === 'done') {
      appendRunMessage(
        state.runId,
        'assistant',
        '設計階段已全部確認，接下來進入任務分派規劃。',
      );
      const checkpoint = {
        ...baseCheckpoint,
        design: { ...design, active_stage: 'done' as const, design_done: true },
        force_redesign: false,
      };
      const next = { ...state, phase: 'plan', status: 'running', checkpoint, pendingCommand: null };
      syncRunMirror(next);
      return { phase: 'plan', status: 'running', checkpoint, pendingCommand: null };
    }
    appendRunMessage(
      state.runId,
      'assistant',
      `已確認「${DESIGN_STAGE_LABELS[stage]}」，進入「${DESIGN_STAGE_LABELS[design.active_stage as DesignStage]}」。`,
    );
  }

  if (design.active_stage === 'done') {
    const checkpoint = {
      ...baseCheckpoint,
      design: { ...design, design_done: true },
      force_redesign: false,
    };
    syncRunMirror({ ...state, phase: 'plan', status: 'running', checkpoint });
    return { phase: 'plan', status: 'running', checkpoint, pendingCommand: null };
  }

  const activeStage = design.active_stage as DesignStage;
  const requirementsSummary =
    typeof state.checkpoint.requirements_summary === 'string'
      ? state.checkpoint.requirements_summary
      : state.goal;

  const result = await buildDesignTurn({
    projectName: project.name,
    projectDesc: project.description ?? '',
    goal: state.goal,
    stage: activeStage,
    design,
    history,
    researchReport: researchReportFromCheckpoint(state.checkpoint),
    requirementsSummary,
  });

  if (result.rollback_to) {
    design = rollbackDesignTo(design, result.rollback_to);
    appendRunMessage(
      state.runId,
      'assistant',
      `收到回退指示，回到「${DESIGN_STAGE_LABELS[result.rollback_to]}」重新對齊。`,
    );
  }

  design = applySkipAndAdvance(design, design.active_stage as DesignStage, result);

  // Auto-skip current if model requested and no artifact needed.
  if (result.skip_current) {
    design = confirmCurrentStage(design, activeStage);
    if (design.design_done || design.active_stage === 'done') {
      appendRunMessage(
        state.runId,
        'assistant',
        `已跳過不必要的設計步驟，直接進入任務分派規劃。\n\n${result.reply}`,
      );
      const checkpoint = {
        ...baseCheckpoint,
        design: { ...design, active_stage: 'done' as const, design_done: true },
        force_redesign: false,
      };
      const next = { ...state, phase: 'plan', status: 'running', checkpoint, pendingCommand: null };
      syncRunMirror(next);
      return { phase: 'plan', status: 'running', checkpoint, pendingCommand: null };
    }
  }

  let reply = result.reply;
  if (result.ready_to_confirm && !/確認設計|确认设计/.test(reply)) {
    reply += '\n\n若以上設計沒問題，請回覆「確認設計」進入下一階段；若要修改請直接說明。';
  }
  appendRunMessage(state.runId, 'assistant', reply);

  const checkpoint = { ...baseCheckpoint, design, force_redesign: false };
  const next = {
    ...state,
    status: 'awaiting_human' as const,
    phase: 'design',
    checkpoint,
    pendingCommand: null,
  };
  syncRunMirror(next);
  interrupt({ reason: 'design', stage: design.active_stage });
  return {
    status: 'awaiting_human',
    phase: 'design',
    checkpoint,
    pendingCommand: null,
  };
}

export function routeAfterDesign(state: OrchestratorStateType): string {
  if (state.status === 'awaiting_human' && state.phase === 'design') return '__interrupt__';
  if (isDesignDone(state.checkpoint) || state.phase === 'plan') return 'planning';
  return '__interrupt__';
}
