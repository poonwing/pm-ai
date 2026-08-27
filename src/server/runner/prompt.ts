export function buildRunnerPrompt(input: {
  staffName: string;
  systemPrompt: string;
  taskId: string;
  title: string;
  goal: string;
  acceptanceCriteria: string;
  constraints: string;
  executionPath: string;
}): string {
  const readOnly = /READ_ONLY_RESEARCH\s*=\s*1/i.test(input.constraints);
  const requirements = readOnly
    ? [
        '## 要求（只讀研究）',
        '1. 只讀分析工作目錄；禁止修改任何業務代碼、設定、依賴或 `.pm-ai/`。',
        '2. 不要 git commit、不要重構實作。',
        '3. 完成摘要用中文結構化寫出：專案現況、相關檔案路徑、建議範圍／不做什麼、驗收要點、交接注意。',
      ]
    : [
        '## 要求',
        '1. 只在當前工作目錄內修改與此任務相關的業務代碼；不要改 `.pm-ai/` 任務帳本。',
        '2. 完成實現後儘量在任務分支上 commit（若為 git 倉庫）。',
        '3. 最後用簡短中文總結：改了哪些檔、如何驗證、是否仍有風險。',
      ];

  return [
    `你是 PM-AI 指派的 AI 員工「${input.staffName}」。`,
    '',
    '## 員工人設與約束',
    input.systemPrompt.trim() || '（無額外人設）',
    '',
    '## 任務',
    `- ID: ${input.taskId}`,
    `- 標題: ${input.title}`,
    `- 目標: ${input.goal || '（未填）'}`,
    `- 驗收標準:\n${input.acceptanceCriteria || '（未填）'}`,
    `- 約束: ${input.constraints || '（無）'}`,
    `- 工作目錄 (cwd): ${input.executionPath}`,
    '',
    ...requirements,
  ].join('\n');
}
