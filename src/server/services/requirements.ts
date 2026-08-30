import fs from 'fs';
import { getProject, ValidationError } from './tasks.js';
import { ensurePmAiStructure } from './files.js';
import { collectWorkspaceBrief } from '../orchestrator/research.js';
import { isModelConfigured } from '../orchestrator/model.js';
import {
  getRequirementsPath,
  REQUIREMENTS_TEMPLATE,
} from '../paths.js';
import {
  appendStudioMessage,
  completeStudioChat,
  extractMarkdown,
  readStudioMessages,
} from './studio-ai.js';
import type { StudioMessage } from '../../shared/schemas.js';

export interface RequirementsDoc {
  markdown: string;
  updatedAt: string | null;
  exists: boolean;
}

/** 自動判斷：嚴格讀碼 / 純描述 / 參考 workspace 混合 */
export type RequirementsAnalysisMode = 'codebase' | 'prompt' | 'assist';

const CODEBASE_HINTS =
  /现有代码|現有代碼|根據代碼|根据代码|从代码|從代碼|读代码|讀代碼|看代码|看代碼|代码整理|代碼整理|整理.*需求|逆向|反推|已有项目|現有專案|现有项目|workspace|源码|源碼|归纳|歸納|梳理|代码库|代碼庫|按代码|按代碼|对照代码|對照代碼/i;

const NEW_PROJECT_HINTS =
  /新项目|新專案|从零|從零|全新产品|全新產品|打算做|想要做|计划开发|計劃開發|准备做|準備做|我要做一個|我要做一个|新功能规划|新功能規劃/i;

export function inferRequirementsAnalysisMode(message: string): RequirementsAnalysisMode {
  const text = message.trim();
  if (CODEBASE_HINTS.test(text)) return 'codebase';
  if (NEW_PROJECT_HINTS.test(text)) return 'prompt';
  return 'assist';
}

function workspaceOf(projectId: string): string {
  const project = getProject(projectId);
  if (project.bindingStatus === 'missing') {
    throw new ValidationError('Workspace 找不到，請先在專案設定重新定位');
  }
  return project.workspacePath;
}

export function ensureRequirementsFile(workspacePath: string): void {
  ensurePmAiStructure(workspacePath);
  const filePath = getRequirementsPath(workspacePath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, REQUIREMENTS_TEMPLATE, 'utf-8');
  }
}

export function getRequirements(projectId: string): RequirementsDoc {
  const workspacePath = workspaceOf(projectId);
  ensureRequirementsFile(workspacePath);
  const filePath = getRequirementsPath(workspacePath);
  const markdown = fs.readFileSync(filePath, 'utf-8');
  const stat = fs.statSync(filePath);
  return {
    markdown,
    updatedAt: stat.mtime.toISOString(),
    exists: true,
  };
}

export function saveRequirements(projectId: string, markdown: string): RequirementsDoc {
  const workspacePath = workspaceOf(projectId);
  ensurePmAiStructure(workspacePath);
  const filePath = getRequirementsPath(workspacePath);
  fs.writeFileSync(filePath, markdown.replace(/\r\n/g, '\n'), 'utf-8');
  const stat = fs.statSync(filePath);
  return {
    markdown,
    updatedAt: stat.mtime.toISOString(),
    exists: true,
  };
}

export function getRequirementsMessages(projectId: string): StudioMessage[] {
  const workspacePath = workspaceOf(projectId);
  return readStudioMessages(workspacePath, 'requirements');
}

export function getRequirementsDownload(projectId: string): { markdown: string; filename: string } {
  const doc = getRequirements(projectId);
  return { markdown: doc.markdown, filename: 'requirements.md' };
}

function buildInternalPrompt(input: {
  projectName: string;
  projectDesc: string;
  mode: RequirementsAnalysisMode;
  message: string;
  current: string;
  brief?: string;
}): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const modeRule =
    input.mode === 'codebase'
      ? '以代碼現況為準，不要憑空編造代碼裡不存在的功能；未知處標「未知」。'
      : input.mode === 'prompt'
        ? '以使用者描述為主；若資訊不足，用合理假設並標出假設。'
        : '結合 workspace 快照與使用者描述：已有代碼時優先對照現況，也可納入新需求；不要憑空編造快照中不存在的功能；假設需標出。';

  const snapshotSection =
    input.brief && input.mode !== 'prompt'
      ? `\n## Workspace 快照\n${input.brief.slice(0, 12000)}`
      : '';

  return [
    {
      role: 'system',
      content: `你是本專案的需求分析員。請產出一份完整、可執行的中文需求文档。

規則：
- 只輸出完整 Markdown 正文（可含一個 markdown 代碼圍欄），不要閒聊。
- 固定章節：背景、目标用户、功能需求、非目标、验收标准、约束与依赖。可依現況增補章節。
- 驗收標準用 checklist（- [ ]）。
- 若已有文檔，在其基礎上修訂，不要無故刪掉仍有效的內容。
- ${modeRule}`,
    },
    {
      role: 'user',
      content: [
        `專案名：${input.projectName}`,
        `專案描述：${input.projectDesc || '（無）'}`,
        '',
        '## 使用者說明',
        input.message,
        '',
        '## 目前需求文档',
        input.current.slice(0, 12000) || '（空模板）',
        snapshotSection,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export async function analyzeRequirements(
  projectId: string,
  input: { message: string },
): Promise<{
  markdown: string;
  updatedAt: string | null;
  messages: StudioMessage[];
  mode: RequirementsAnalysisMode;
}> {
  const project = getProject(projectId);
  const workspacePath = workspaceOf(projectId);
  ensureRequirementsFile(workspacePath);
  const current = fs.readFileSync(getRequirementsPath(workspacePath), 'utf-8');

  const message = input.message.trim();
  if (!message) {
    throw new ValidationError('請輸入需求說明');
  }

  const mode = inferRequirementsAnalysisMode(message);

  appendStudioMessage(workspacePath, 'requirements', {
    role: 'user',
    content: message,
  });

  if (!isModelConfigured()) {
    throw new ValidationError('未設定 ZAI_API_KEY，無法使用 AI');
  }

  const brief = mode !== 'prompt' ? collectWorkspaceBrief(workspacePath) : undefined;
  const raw = await completeStudioChat(
    buildInternalPrompt({
      projectName: project.name,
      projectDesc: project.description ?? '',
      mode,
      message,
      current,
      brief,
    }),
    { temperature: 0.3 },
  );
  const markdown = extractMarkdown(raw);
  if (!markdown) throw new ValidationError('AI 未產出需求文档');
  const saved = saveRequirements(projectId, markdown);

  const modeNote =
    mode === 'codebase'
      ? '（已參考 workspace 代碼快照整理）'
      : mode === 'assist'
        ? '（已參考 workspace 概況）'
        : '';
  appendStudioMessage(workspacePath, 'requirements', {
    role: 'assistant',
    content: `已更新需求文档${modeNote}。可在右側預覽或繼續對話修訂。`,
  });
  return {
    markdown: saved.markdown,
    updatedAt: saved.updatedAt,
    messages: readStudioMessages(workspacePath, 'requirements'),
    mode,
  };
}
