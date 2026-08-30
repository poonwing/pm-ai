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
import type { RequirementsSource, StudioMessage } from '../../shared/schemas.js';

export interface RequirementsDoc {
  markdown: string;
  updatedAt: string | null;
  exists: boolean;
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
  source: RequirementsSource;
  message: string;
  current: string;
  brief?: string;
}): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const fromCode = input.source === 'codebase';
  return [
    {
      role: 'system',
      content: `你是本專案的需求分析員。請根據使用者說明${fromCode ? '與現有代碼快照' : ''}，產出一份完整、可執行的中文需求文档。

規則：
- 只輸出完整 Markdown 正文（可含一個 markdown 代碼圍欄），不要閒聊。
- 固定章節：背景、目标用户、功能需求、非目标、验收标准、约束与依赖。可依現況增補章節。
- 驗收標準用 checklist（- [ ]）。
- 若已有文檔，在其基礎上修訂，不要無故刪掉仍有效的內容。
- ${fromCode ? '以代碼現況為準，不要憑空編造代碼裡不存在的功能；未知處標「未知」。' : '若資訊不足，用合理假設並標出假設。'}`,
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
        fromCode && input.brief
          ? `\n## Workspace 快照\n${input.brief.slice(0, 12000)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export async function analyzeRequirements(
  projectId: string,
  input: { source: RequirementsSource; message: string },
): Promise<{
  markdown: string;
  updatedAt: string | null;
  messages: StudioMessage[];
}> {
  const project = getProject(projectId);
  const workspacePath = workspaceOf(projectId);
  ensureRequirementsFile(workspacePath);
  const current = fs.readFileSync(getRequirementsPath(workspacePath), 'utf-8');

  const message =
    input.message.trim() ||
    (input.source === 'codebase' ? '請根據現有代碼整理完整需求文档' : '');
  if (!message) {
    throw new ValidationError('請輸入需求說明');
  }

  appendStudioMessage(workspacePath, 'requirements', {
    role: 'user',
    content: input.source === 'codebase' ? `【根據現有代碼】${message}` : message,
  });

  if (!isModelConfigured()) {
    throw new ValidationError('未設定 ZAI_API_KEY，無法使用 AI');
  }
  const brief =
    input.source === 'codebase' ? collectWorkspaceBrief(workspacePath) : undefined;
  const raw = await completeStudioChat(
    buildInternalPrompt({
      projectName: project.name,
      projectDesc: project.description ?? '',
      source: input.source,
      message,
      current,
      brief,
    }),
    { temperature: 0.3 },
  );
  const markdown = extractMarkdown(raw);
  if (!markdown) throw new ValidationError('AI 未產出需求文档');
  const saved = saveRequirements(projectId, markdown);
  appendStudioMessage(workspacePath, 'requirements', {
    role: 'assistant',
    content: '已更新需求文档。可在右側預覽或繼續對話修訂。',
  });
  return {
    markdown: saved.markdown,
    updatedAt: saved.updatedAt,
    messages: readStudioMessages(workspacePath, 'requirements'),
  };
}
