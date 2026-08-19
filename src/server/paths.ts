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

export const PM_AI_README = `# PM-AI Workspace

此目錄由 PM-AI 專案管理系統管理。

## 目錄結構

- \`project.yml\` — 專案設定
- \`tasks/\` — 任務檔案（markdown + YAML frontmatter）
- \`activity/\` — 活動日誌（jsonl）
- \`comments/\` — 任務評論（每任務一個 jsonl）

## 重要約定

- **Agent 請勿直接修改 \`tasks/\` 目錄下的檔案**，應透過 API 更新任務狀態
- 任務狀態變更請走 \`http://127.0.0.1:7432/api/v1\`
- 人可以直接編輯草稿任務的 markdown 內容
- 新建 PM-AI 專案時，會自動安裝 Cursor Skill 至 \`.cursor/skills/pm-ai-agent/SKILL.md\`
`;

export const PM_AI_GITIGNORE = `locks/
cache/
`;
