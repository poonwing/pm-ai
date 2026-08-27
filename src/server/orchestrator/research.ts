import fs from 'fs';
import path from 'path';
import { chatCompletion, isModelConfigured } from './model.js';

const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.pm-ai',
  'vendor',
  '__pycache__',
  '.cursor',
]);

function safeRead(filePath: string, max = 4000): string | null {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.length > max ? `${raw.slice(0, max)}\n…(截斷)` : raw;
  } catch {
    return null;
  }
}

function listTopLevel(workspacePath: string, limit = 40): string[] {
  try {
    return fs
      .readdirSync(workspacePath, { withFileTypes: true })
      .filter((d) => !SKIP_DIR.has(d.name) && !d.name.startsWith('.'))
      .slice(0, limit)
      .map((d) => `${d.isDirectory() ? 'dir' : 'file'}: ${d.name}`);
  } catch {
    return [];
  }
}

function findShallowFiles(workspacePath: string, names: string[], depth = 2): string[] {
  const found: string[] = [];
  const walk = (dir: string, d: number) => {
    if (found.length >= 8 || d < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && names.includes(e.name.toLowerCase())) {
        found.push(path.relative(workspacePath, full).replace(/\\/g, '/'));
      } else if (e.isDirectory() && d > 0) {
        walk(full, d - 1);
      }
    }
  };
  walk(workspacePath, depth);
  return found;
}

/** Cheap local snapshot when Runner is unavailable or as research fallback. */
export function collectWorkspaceBrief(workspacePath: string): string {
  const lines: string[] = [`workspace: ${workspacePath}`, '', '## 頂層', ...listTopLevel(workspacePath)];

  const candidates = [
    'README.md',
    'readme.md',
    'README',
    'package.json',
    'index.html',
    'game.js',
    'main.js',
    'app.js',
  ];
  for (const name of candidates) {
    const content = safeRead(path.join(workspacePath, name), name.endsWith('.json') ? 2000 : 3000);
    if (content) {
      lines.push('', `## ${name}`, content);
    }
  }

  const extras = findShallowFiles(
    workspacePath,
    ['readme.md', 'package.json', 'index.html', 'cargo.toml', 'pyproject.toml', 'go.mod'],
    2,
  ).filter((p) => !candidates.some((c) => p.toLowerCase() === c.toLowerCase()));
  for (const rel of extras.slice(0, 4)) {
    const content = safeRead(path.join(workspacePath, rel), 2000);
    if (content) lines.push('', `## ${rel}`, content);
  }

  return lines.join('\n').slice(0, 14000);
}

export async function summarizeResearchForGoal(
  workspaceBrief: string,
  goal: string,
  projectName: string,
  projectDesc: string,
): Promise<string> {
  if (!isModelConfigured()) {
    return [
      '## 研究報告（本機快照，未配置模型）',
      `專案：${projectName}`,
      projectDesc ? `描述：${projectDesc}` : '',
      `需求：${goal}`,
      '',
      workspaceBrief,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000);
  }

  try {
    const content = await chatCompletion(
      [
        {
          role: 'system',
          content: `你是程式庫研究員。根據提供的 workspace 快照與用戶需求，輸出精簡中文研究報告（不要改代碼）。
固定章節：
1. 專案現況（類型、技術棧、入口）
2. 與需求相關的檔案／模組
3. 建議範圍與不做什麼
4. 建議驗收要點
5. 給後續員工的注意事項
若快照不足請明確寫「未知」。`,
        },
        {
          role: 'user',
          content: [
            `專案名：${projectName}`,
            `專案描述：${projectDesc || '（無）'}`,
            `本次需求：${goal}`,
            '',
            '## Workspace 快照',
            workspaceBrief.slice(0, 12000),
          ].join('\n'),
        },
      ],
      { temperature: 0.2 },
    );
    return content.trim().slice(0, 8000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      '## 研究報告（快照；模型摘要失敗）',
      `錯誤：${msg}`,
      '',
      workspaceBrief.slice(0, 6000),
    ].join('\n');
  }
}

export const RESEARCH_CONSTRAINTS = [
  'READ_ONLY_RESEARCH=1',
  '禁止修改任何業務檔案、依賴或設定；只讀分析。',
  '不要 git commit。',
  '完成摘要必須包含：專案現況、相關路徑、建議範圍、驗收要點、交接注意。',
].join('\n');

export const RESEARCH_ACCEPTANCE = [
  '- [ ] 已瀏覽 workspace 關鍵檔案（只讀）',
  '- [ ] 完成摘要含專案類型／技術棧／入口',
  '- [ ] 列出與需求相關的路徑',
  '- [ ] 給出建議範圍與驗收要點',
  '- [ ] 未修改業務代碼',
].join('\n');
