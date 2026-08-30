import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getProject, NotFoundError, ValidationError } from './tasks.js';
import { ensurePmAiStructure } from './files.js';
import { isModelConfigured } from '../orchestrator/model.js';
import {
  DESIGN_HTML_TEMPLATE,
  getDesignHtmlPath,
  getDesignsDir,
  getRequirementsPath,
} from '../paths.js';
import {
  appendStudioMessage,
  completeStudioChat,
  extractHtml,
  readStudioMessages,
  readDesignManifest,
  writeDesignManifest,
  reconcileDesignsFromDisk,
  type DesignManifestItem,
} from './studio-ai.js';
import type { StudioMessage } from '../../shared/schemas.js';

export interface DesignRecord extends DesignManifestItem {
  html: string;
}

function workspaceOf(projectId: string): string {
  const project = getProject(projectId);
  if (project.bindingStatus === 'missing') {
    throw new ValidationError('Workspace 找不到，請先在專案設定重新定位');
  }
  return project.workspacePath;
}

function slugify(title: string, used: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `page-${Date.now().toString(36)}`;
  let slug = base;
  let n = 2;
  while (used.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function assertSafeSlug(slug: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ValidationError('非法設計稿檔名');
  }
  return slug;
}

function currentRequirementsExcerpt(workspacePath: string): string {
  const filePath = getRequirementsPath(workspacePath);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8').slice(0, 2500);
}

export function listDesigns(projectId: string): DesignManifestItem[] {
  const workspacePath = workspaceOf(projectId);
  ensurePmAiStructure(workspacePath);
  fs.mkdirSync(getDesignsDir(workspacePath), { recursive: true });
  return reconcileDesignsFromDisk(workspacePath);
}

export function getDesign(projectId: string, designId: string): DesignRecord {
  const items = listDesigns(projectId);
  const item = items.find((d) => d.id === designId);
  if (!item) throw new NotFoundError('設計稿不存在');
  const workspacePath = workspaceOf(projectId);
  const filePath = getDesignHtmlPath(workspacePath, assertSafeSlug(item.slug));
  if (!fs.existsSync(filePath)) throw new NotFoundError('設計稿檔案遺失');
  return { ...item, html: fs.readFileSync(filePath, 'utf-8') };
}

export function createDesign(projectId: string, title: string): DesignRecord {
  const workspacePath = workspaceOf(projectId);
  ensurePmAiStructure(workspacePath);
  fs.mkdirSync(getDesignsDir(workspacePath), { recursive: true });
  const items = readDesignManifest(workspacePath);
  const slug = slugify(title, new Set(items.map((d) => d.slug)));
  const item: DesignManifestItem = {
    id: uuidv4(),
    title: title.trim(),
    slug,
    updatedAt: new Date().toISOString(),
  };
  const filePath = getDesignHtmlPath(workspacePath, slug);
  const html = DESIGN_HTML_TEMPLATE.replace('<title>設計稿</title>', `<title>${escapeHtml(item.title)}</title>`).replace(
    '<h1>新頁面</h1>',
    `<h1>${escapeHtml(item.title)}</h1>`,
  );
  fs.writeFileSync(filePath, html, 'utf-8');
  items.push(item);
  writeDesignManifest(workspacePath, items);
  return { ...item, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function updateDesign(
  projectId: string,
  designId: string,
  patch: { title?: string; html?: string },
): DesignRecord {
  const workspacePath = workspaceOf(projectId);
  const items = listDesigns(projectId);
  const index = items.findIndex((d) => d.id === designId);
  if (index < 0) throw new NotFoundError('設計稿不存在');
  const item = items[index]!;
  assertSafeSlug(item.slug);
  const filePath = getDesignHtmlPath(workspacePath, item.slug);
  if (patch.title?.trim()) item.title = patch.title.trim();
  if (typeof patch.html === 'string') {
    fs.writeFileSync(filePath, patch.html.replace(/\r\n/g, '\n'), 'utf-8');
  }
  item.updatedAt = new Date().toISOString();
  items[index] = item;
  writeDesignManifest(workspacePath, items);
  const html = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : DESIGN_HTML_TEMPLATE;
  return { ...item, html };
}

export function deleteDesign(projectId: string, designId: string): { deleted: boolean; id: string } {
  const workspacePath = workspaceOf(projectId);
  const items = listDesigns(projectId);
  const item = items.find((d) => d.id === designId);
  if (!item) throw new NotFoundError('設計稿不存在');
  const filePath = getDesignHtmlPath(workspacePath, assertSafeSlug(item.slug));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  writeDesignManifest(
    workspacePath,
    items.filter((d) => d.id !== designId),
  );
  return { deleted: true, id: designId };
}

export function getDesignMessages(projectId: string): StudioMessage[] {
  return readStudioMessages(workspaceOf(projectId), 'design');
}

export function getDesignDownload(
  projectId: string,
  designId: string,
): { html: string; filename: string } {
  const design = getDesign(projectId, designId);
  return { html: design.html, filename: `${design.slug}.html` };
}

function buildInternalPrompt(input: {
  projectName: string;
  message: string;
  title: string;
  currentHtml: string;
  requirements: string;
  isNew: boolean;
}): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    {
      role: 'system',
      content: `你是本專案的 UI 設計師。請用原生 HTML + 內聯 CSS 產出一份可在瀏覽器預覽的設計稿，方便日後開發對照。

規則：
- 只輸出完整 HTML（含 <!DOCTYPE html>），不要 Markdown 閒聊。可用一個 html 代碼圍欄。
- CSS 寫在 <style> 內；可用少量內聯 JS 做 Tab／彈層／狀態切換。
- 禁止 Tailwind、React、外部 CDN、外部字體或圖片熱鏈（可用 SVG／CSS 漸層）。
- 標註空狀態／載入／錯誤若與需求相關。
- 保持單一頁面、自包含；語意化標籤與基本無障礙（label、對比）。
- 頁面保持精簡：必要結構與樣式即可，避免超長註解與重複 CSS，以便一次生成完。`,
    },
    {
      role: 'user',
      content: [
        `專案名：${input.projectName}`,
        `頁面標題：${input.title}`,
        input.isNew ? '這是新建頁面。' : '請在現有 HTML 上迭代，保留仍有效的結構與樣式。',
        '',
        '## 使用者說明',
        input.message,
        input.requirements ? `\n## 需求文档摘要\n${input.requirements}` : '',
        '',
        '## 目前 HTML',
        input.currentHtml.slice(0, 8000) || '（空骨架）',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export async function generateDesign(
  projectId: string,
  input: { message: string; designId?: string; title?: string },
): Promise<{
  design: DesignRecord;
  designs: DesignManifestItem[];
  messages: StudioMessage[];
}> {
  const project = getProject(projectId);
  const workspacePath = workspaceOf(projectId);
  ensurePmAiStructure(workspacePath);

  let design: DesignRecord;
  let isNew = false;
  if (input.designId) {
    design = getDesign(projectId, input.designId);
  } else {
    isNew = true;
    design = createDesign(projectId, input.title?.trim() || '新頁面');
  }

  appendStudioMessage(workspacePath, 'design', {
    role: 'user',
    content: `【${design.title}】${input.message}`,
  });

  if (!isModelConfigured()) {
    throw new ValidationError('未設定 ZAI_API_KEY，無法使用 AI');
  }
  const raw = await completeStudioChat(
    buildInternalPrompt({
      projectName: project.name,
      message: input.message,
      title: design.title,
      currentHtml: design.html,
      requirements: currentRequirementsExcerpt(workspacePath),
      isNew,
    }),
    { temperature: 0.5 },
  );
  const html = extractHtml(raw);
  if (!html.includes('<html') && !html.includes('<HTML')) {
    throw new ValidationError('AI 未產出完整 HTML');
  }
  const saved = updateDesign(projectId, design.id, { html });
  appendStudioMessage(workspacePath, 'design', {
    role: 'assistant',
    content: `已更新設計稿「${saved.title}」。可在右側預覽或切換源碼。`,
  });
  return {
    design: saved,
    designs: listDesigns(projectId),
    messages: readStudioMessages(workspacePath, 'design'),
  };
}
