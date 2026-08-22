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
    '## 要求',
    '1. 只在當前工作目錄內修改與此任務相關的業務代碼；不要改 `.pm-ai/` 任務帳本。',
    '2. 完成實現後儘量在任務分支上 commit（若為 git 倉庫）。',
    '3. 最後用簡短中文總結：改了哪些檔、如何驗證、是否仍有風險。',
  ].join('\n');
}
