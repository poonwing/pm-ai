export type RunnerProvider = 'cursor' | 'opencode';

export type RunnerJobStatus =
  | 'queued'
  | 'claiming'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RunnerJob {
  id: string;
  projectId: string;
  taskId: string;
  autoRunId?: string | null;
  status: RunnerJobStatus;
  agentName: string;
  provider?: RunnerProvider;
  error?: string | null;
  sdkRunId?: string | null;
  resultSummary?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getRunnerProvider(): RunnerProvider {
  const raw = (process.env.RUNNER_PROVIDER ?? 'cursor').toLowerCase().trim();
  return raw === 'opencode' ? 'opencode' : 'cursor';
}

export function getCursorRunnerConfig() {
  return {
    apiKey: process.env.CURSOR_API_KEY ?? '',
    model: process.env.CURSOR_MODEL ?? 'composer-2.5',
    concurrency: Math.max(1, Number(process.env.CURSOR_RUNNER_CONCURRENCY ?? '1') || 1),
  };
}

export function getOpenCodeRunnerConfig() {
  const modelId = process.env.OPENCODE_MODEL ?? process.env.ZAI_MODEL ?? 'glm-4.7';
  const baseURL =
    process.env.ZAI_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4';
  const providerId = process.env.OPENCODE_PROVIDER ?? 'zai-coding-plan';
  return {
    apiKey: process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? '',
    baseURL: baseURL.replace(/\/?$/, ''),
    modelId,
    providerId,
    /** provider/model，传给 OpenCode config.model */
    modelRef: process.env.OPENCODE_MODEL_REF ?? `${providerId}/${modelId}`,
    concurrency: Math.max(1, Number(process.env.OPENCODE_RUNNER_CONCURRENCY ?? '1') || 1),
  };
}

export function isCursorRunnerConfigured(): boolean {
  return Boolean(getCursorRunnerConfig().apiKey);
}

export function isOpenCodeRunnerConfigured(): boolean {
  return Boolean(getOpenCodeRunnerConfig().apiKey);
}

export function isRunnerConfigured(provider = getRunnerProvider()): boolean {
  return provider === 'opencode' ? isOpenCodeRunnerConfigured() : isCursorRunnerConfigured();
}

export function getRunnerConcurrency(): number {
  return getRunnerProvider() === 'opencode'
    ? getOpenCodeRunnerConfig().concurrency
    : getCursorRunnerConfig().concurrency;
}
