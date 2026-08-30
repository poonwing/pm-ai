import path from 'path';
import os from 'os';
import fs from 'fs';

export function getAppDataDir(): string {
  const base =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  const dir = path.join(base, 'pm-ai');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getConfigPath(): string {
  return path.join(getAppDataDir(), 'config.json');
}

export function getDbPath(): string {
  return path.join(getAppDataDir(), 'pm-ai.sqlite');
}

export function getPmAiDir(workspacePath: string): string {
  return path.join(workspacePath, '.pm-ai');
}

export function getTasksDir(workspacePath: string): string {
  return path.join(getPmAiDir(workspacePath), 'tasks');
}

export function getActivityDir(workspacePath: string): string {
  return path.join(getPmAiDir(workspacePath), 'activity');
}

export function getProjectConfigPath(workspacePath: string): string {
  return path.join(getPmAiDir(workspacePath), 'project.yml');
}

export function getCommentsDir(workspacePath: string): string {
  return path.join(getPmAiDir(workspacePath), 'comments');
}

export function getLocksDir(workspacePath: string): string {
  return path.join(getPmAiDir(workspacePath), 'locks');
}

export function getRequirementsPath(workspacePath: string): string {
  return path.join(getPmAiDir(workspacePath), 'requirements.md');
}

export function getRequirementsChatPath(workspacePath: string): string {
  return path.join(getPmAiDir(workspacePath), 'requirements.chat.jsonl');
}

export function getDesignsDir(workspacePath: string): string {
  return path.join(getPmAiDir(workspacePath), 'designs');
}

export function getDesignsManifestPath(workspacePath: string): string {
  return path.join(getDesignsDir(workspacePath), 'manifest.yml');
}

export function getDesignsChatPath(workspacePath: string): string {
  return path.join(getDesignsDir(workspacePath), 'chat.jsonl');
}

export function getDesignHtmlPath(workspacePath: string, slug: string): string {
  return path.join(getDesignsDir(workspacePath), `${slug}.html`);
}

export const REQUIREMENTS_TEMPLATE = `# 需求文档

## 背景

（專案要解決什麼問題、現況與動機）

## 目标用户

（誰會用、主要場景）

## 功能需求

- 

## 非目标

- （明確不做什麼，避免範圍蔓延）

## 验收标准

- [ ] 

## 约束与依赖

- 
`;

export const DESIGN_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>設計稿</title>
  <style>
    /* 給日後開發對照：原生 CSS，勿引入框架或 CDN */
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
      color: #18181b;
      background: #fafafa;
      line-height: 1.5;
    }
    main { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 1.5rem; margin: 0 0 12px; }
    p { margin: 0; color: #52525b; }
  </style>
</head>
<body>
  <main>
    <h1>新頁面</h1>
    <p>與 AI 對話以迭代此設計稿。產出請保持自包含 HTML + 內聯 CSS。</p>
  </main>
</body>
</html>
`;

export const PM_AI_README = `# PM-AI Workspace

此目錄由 PM-AI 專案管理系統管理。

## 目錄結構

- \`project.yml\` — 專案設定
- \`tasks/\` — 任務檔案（markdown + YAML frontmatter）
- \`activity/\` — 活動日誌（jsonl）
- \`comments/\` — 任務評論（每任務一個 jsonl）
- \`requirements.md\` — 需求分析文档（每個專案一份）
- \`requirements.chat.jsonl\` — 需求分析對話
- \`designs/\` — UI 設計稿（原生 HTML/CSS）與對話

## 重要約定

- **Agent 請勿直接修改 \`tasks/\` 目錄下的檔案**，應透過 API 更新任務狀態
- 任務狀態變更請走 \`http://127.0.0.1:7432/api/v1\`
- 人可以直接編輯草稿任務的 markdown 內容
- 人可以直接編輯 \`requirements.md\` 與 \`designs/*.html\`（亦可經 API 讀寫；本機 Agent 同樣可讀這些檔）
- 新建 PM-AI 專案時，會自動安裝 Cursor Skill 至 \`.cursor/skills/pm-ai-agent/SKILL.md\`
`;

export const PM_AI_GITIGNORE = `locks/
cache/
`;
