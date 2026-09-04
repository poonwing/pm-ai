export type RunnerProvider = 'cursor' | 'pi';

export type RunnerJobStatus =
  | 'queued'
  | 'claiming'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunnerJobKind = 'task' | 'studio' | 'chat';
export type StudioKind = 'requirements' | 'design';

export interface RunnerJob {
  id: string;
  projectId: string;
  taskId: string;
  autoRunId?: string | null;
  chatSessionId?: string | null;
  kind: RunnerJobKind;
  studioKind?: StudioKind;
  prompt?: string;
  cwd?: string;
  status: RunnerJobStatus;
  agentName: string;
  provider?: RunnerProvider;
  error?: string | null;
  sdkRunId?: string | null;
  resultSummary?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getDefaultRunnerProvider(): RunnerProvider {
  const raw = (process.env.RUNNER_PROVIDER ?? 'cursor').toLowerCase().trim();
  // opencode 為歷史別名，統一映射到 pi
  if (raw === 'pi' || raw === 'opencode') return 'pi';
  return 'cursor';
}

/** @deprecated 使用 getDefaultRunnerProvider；專案級請用 resolveRunnerProvider(projectId) */
export function getRunnerProvider(): RunnerProvider {
  return getDefaultRunnerProvider();
}

export function parseRunnerProvider(value: unknown): RunnerProvider | null {
  if (value === 'cursor' || value === 'pi') return value;
  if (value === 'opencode') return 'pi';
  return null;
}

export function runnerProviderLabel(provider: RunnerProvider): string {
  return provider === 'pi' ? 'Pi Agent' : 'Cursor SDK';
}

export function runnerProviderAgentName(provider: RunnerProvider): string {
  return provider === 'pi' ? 'pi-agent' : 'cursor-sdk';
}

export function getCursorRunnerConfig() {
  return {
    apiKey: process.env.CURSOR_API_KEY ?? '',
    model: process.env.CURSOR_MODEL ?? 'composer-2.5',
    concurrency: Math.max(1, Number(process.env.CURSOR_RUNNER_CONCURRENCY ?? '1') || 1),
  };
}

/**
 * Pi Agent（@earendil-works/pi-coding-agent）接 GLM Coding Plan。
 * - 預設依 ZAI_BASE_URL 選 provider：bigmodel.cn → zai-coding-cn，其餘 → zai
 * - 可用 PI_PROVIDER / PI_MODEL 覆蓋
 */
export function getPiRunnerConfig() {
  const baseURL = (
    process.env.ZAI_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4'
  ).replace(/\/?$/, '');
  const isCn = /bigmodel\.cn/i.test(baseURL);
  const providerId =
    (process.env.PI_PROVIDER ?? (isCn ? 'zai-coding-cn' : 'zai')).trim() ||
    (isCn ? 'zai-coding-cn' : 'zai');
  const modelId = (process.env.PI_MODEL ?? process.env.ZAI_MODEL ?? 'glm-4.7').trim();
  const thinkingRaw = (process.env.PI_THINKING_LEVEL ?? 'off').toLowerCase().trim();
  const thinkingLevel =
    thinkingRaw === 'low' ||
    thinkingRaw === 'medium' ||
    thinkingRaw === 'high' ||
    thinkingRaw === 'xhigh'
      ? thinkingRaw
      : 'off';

  return {
    apiKey: process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY ?? '',
    baseURL,
    providerId,
    modelId,
    thinkingLevel: thinkingLevel as 'off' | 'low' | 'medium' | 'high' | 'xhigh',
    concurrency: Math.max(1, Number(process.env.PI_RUNNER_CONCURRENCY ?? '1') || 1),
  };
}

/** @deprecated 使用 getPiRunnerConfig */
export function getOpenCodeRunnerConfig() {
  const pi = getPiRunnerConfig();
  return {
    apiKey: pi.apiKey,
    baseURL: pi.baseURL,
    modelId: pi.modelId,
    providerId: pi.providerId,
    modelRef: `${pi.providerId}/${pi.modelId}`,
    concurrency: pi.concurrency,
  };
}

export function isCursorRunnerConfigured(): boolean {
  return Boolean(getCursorRunnerConfig().apiKey);
}

export function isPiRunnerConfigured(): boolean {
  return Boolean(getPiRunnerConfig().apiKey);
}

/** @deprecated 使用 isPiRunnerConfigured */
export function isOpenCodeRunnerConfigured(): boolean {
  return isPiRunnerConfigured();
}

export function isRunnerConfigured(provider = getDefaultRunnerProvider()): boolean {
  return provider === 'pi' ? isPiRunnerConfigured() : isCursorRunnerConfigured();
}

export function getRunnerConcurrency(provider = getDefaultRunnerProvider()): number {
  return provider === 'pi'
    ? getPiRunnerConfig().concurrency
    : getCursorRunnerConfig().concurrency;
}
