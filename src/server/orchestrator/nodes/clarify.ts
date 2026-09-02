import { appendRunMessage, getAutoRunMessages } from '../../services/auto.js';
import { getProject } from '../../services/tasks.js';
import { chatCompletion, isModelConfigured } from '../model.js';
import { interrupt } from '@langchain/langgraph';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';
import {
  isClarified,
  parseJsonLoose,
  researchReportFromCheckpoint,
  type ClarifyResult,
} from '../helpers.js';

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

export async function clarifyNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  if (state.skipClarify || isClarified(state.checkpoint)) {
    const next = { ...state, status: 'running', phase: 'agree_review_policy' };
    syncRunMirror(next);
    return { status: 'running', phase: 'agree_review_policy' };
  }

  const project = getProject(state.projectId);
  const history = getAutoRunMessages(state.runId);
  const result = await buildClarify(
    project.name,
    project.description ?? '',
    state.goal,
    history,
    researchReportFromCheckpoint(state.checkpoint),
  );

  let reply = result.reply;
  if (result.ready_to_execute && !/開始工作|开始工作/.test(reply)) {
    reply += '\n\n若以上理解無誤，請回覆「開始工作」開始執行；若要修正請直接補充。';
  }

  appendRunMessage(state.runId, 'assistant', reply);
  const checkpoint = {
    ...state.checkpoint,
    clarified: false,
    requirements_summary: result.requirements_summary,
    ready_to_execute: result.ready_to_execute,
  };
  const next = {
    ...state,
    status: 'awaiting_human',
    phase: 'clarify',
    goal: result.updated_goal ?? state.goal,
    checkpoint,
  };
  syncRunMirror(next);
  interrupt({ reason: 'clarify' });
  return {
    status: 'awaiting_human',
    phase: 'clarify',
    goal: next.goal,
    checkpoint,
  };
}
