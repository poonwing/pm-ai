import { appendRunMessage, getAutoRunMessages, getReviewPolicy } from '../../services/auto.js';
import { getProject } from '../../services/tasks.js';
import { listStaffAgents } from '../../services/agents.js';
import { chatCompletion, isModelConfigured } from '../model.js';
import type { ReviewPolicy } from '../../../shared/schemas.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';
import {
  formatDesignArtifacts,
  normalizePlan,
  parseJsonLoose,
  researchReportFromCheckpoint,
  type OrchestratorPlan,
} from '../helpers.js';

async function buildPlan(
  projectName: string,
  projectDesc: string,
  goal: string,
  history: Array<{ role: string; content: string }>,
  policy: ReviewPolicy,
  existingStaff: Array<{ name: string; role: string; system_prompt: string }>,
  researchReport: string,
  designArtifacts: string,
): Promise<OrchestratorPlan> {
  if (!isModelConfigured()) {
    return normalizePlan({
      summary: `離線規劃（未配置模型）：圍繞「${goal}」分派既有開發與測試員工。`,
      staff: [],
      tasks: [
        {
          id: 'dev1',
          title: `實現：${goal.slice(0, 40)}`,
          goal,
          acceptance_criteria: '- [ ] 功能可用\n- [ ] 無明顯回歸',
          role: 'developer',
          queue_order: 1,
          reviewer_type: policy.default_reviewer_type,
          depends_on: [],
        },
        {
          id: 'test1',
          title: `測試：${goal.slice(0, 40)}`,
          goal: `驗證 ${goal}`,
          acceptance_criteria: '- [ ] 關鍵路徑通過',
          role: 'tester',
          queue_order: 2,
          reviewer_type: 'none',
          depends_on: ['dev1'],
        },
      ],
    });
  }

  const staffRoster = existingStaff
    .map((s) => {
      const promptPreview =
        s.system_prompt.length > 160 ? `${s.system_prompt.slice(0, 160)}…` : s.system_prompt;
      return `- ${s.name} (role=${s.role}): ${promptPreview}`;
    })
    .join('\n');

  const system = `你是 PM-AI 專案協調者。根據專案、設計產物與用戶目標輸出 JSON 分派計劃（不要 markdown 說明）。
專案：${projectName}
描述：${projectDesc || '（無）'}
預設審查：${policy.default_reviewer_type}

${
  researchReport
    ? `研究員 workspace 報告（規劃時請尊重現況，避免重寫整個專案）：\n${researchReport.slice(0, 4000)}`
    : '（無研究報告）'
}

已確認的設計產物（請據此分派，勿推翻已確認架構，除非用戶另有指示）：
${designArtifacts.slice(0, 8000)}

專案已有固定可分派員工（優先使用，不要重複建立同 role；researcher 通常不必再派實作任務）：
${staffRoster || '（尚無）'}

規則：
- tasks 必須有穩定 id（短英文/數字，如 sys1、ui1、dev1）
- depends_on 列出必須先完成（且通過審查）的其他 task id；可形成分波執行
- 通常：設計文檔任務 → 實作 → code review / 測試；簡單需求可跳過設計任務直接開發
- tasks.role 必須對應上列既有 role，或你在 staff 裡擬新增的非常規 role
- staff 陣列僅用於：(1) 依本目標微調既有角色的 system_prompt；(2) 缺職能時新增非常規角色
- 不需要調整提示詞時 staff 可為 []
- 不要再建立「研究／探勘」任務（研究已完成）
- 常用既有 role：analyst / designer / developer / tester / reviewer
- reviewer_type：重要交付用 human；測試／小修可用 none 或 agent；orchestrator 為協調者復查
- 測試類任務若無需人類驗收，設 reviewer_type=none

JSON schema:
{
  "summary": string,
  "staff": [{"name","role","system_prompt","skills_tags":string[]}],
  "tasks": [{"id":string,"title":string,"goal":string,"acceptance_criteria":string,"role":string,"queue_order":number,"reviewer_type":string,"depends_on":string[]}],
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

export async function planNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const project = getProject(state.projectId);
  const history = getAutoRunMessages(state.runId);
  const roster = listStaffAgents(state.projectId, { assignableOnly: true });

  appendRunMessage(state.runId, 'assistant', '正在依設計產物規劃任務分派…');
  const plan = await buildPlan(
    project.name,
    project.description ?? '',
    state.goal,
    history,
    getReviewPolicy(state.projectId),
    roster.map((s) => ({
      name: s.name,
      role: s.role,
      system_prompt: s.system_prompt,
    })),
    researchReportFromCheckpoint(state.checkpoint),
    formatDesignArtifacts(state.checkpoint),
  );

  appendRunMessage(state.runId, 'assistant', plan.summary || '計劃已生成');

  const checkpoint = {
    ...state.checkpoint,
    plan,
    force_redesign: false,
    dispatch: {
      task_map: {},
      enqueued: [],
      waves_done: 0,
    },
  };
  const next = {
    ...state,
    phase: 'plan',
    status: 'running',
    plan,
    checkpoint,
    forceReplan: false,
    createdTaskIds: [],
  };
  syncRunMirror(next);
  return {
    phase: 'plan',
    status: 'running',
    plan,
    checkpoint,
    forceReplan: false,
    createdTaskIds: [],
  };
}

export function routeAfterPlan(state: OrchestratorStateType): string {
  const plan = state.plan;
  if (!plan) return 'ensureStaff';
  if (plan.need_decision && plan.decision) return 'decisionGate';
  if (plan.need_meeting && plan.meeting_topic) return 'meeting';
  return 'ensureStaff';
}
