import { Agent, CursorAgentError } from '@cursor/sdk';
import { getCursorRunnerConfig } from './types.js';

export interface CursorSdkRunOutcome {
  ok: boolean;
  status: string;
  runId?: string;
  resultText?: string;
  error?: string;
  durationMs?: number;
}

export async function runCursorSdkPrompt(input: {
  prompt: string;
  cwd: string;
  name?: string;
  signal?: AbortSignal;
}): Promise<CursorSdkRunOutcome> {
  const cfg = getCursorRunnerConfig();
  if (!cfg.apiKey) {
    return { ok: false, status: 'error', error: '未配置 CURSOR_API_KEY' };
  }

  if (input.signal?.aborted) {
    return { ok: false, status: 'cancelled', error: '已取消' };
  }

  try {
    // Prefer create+send so we can cancel mid-run.
    await using agent = await Agent.create({
      apiKey: cfg.apiKey,
      model: { id: cfg.model },
      name: input.name ?? 'pm-ai-runner',
      local: { cwd: input.cwd },
    });

    const run = await agent.send(input.prompt);
    const onAbort = () => {
      if (run.supports('cancel')) {
        void run.cancel().catch(() => undefined);
      }
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await run.wait();
      if (result.status === 'finished') {
        return {
          ok: true,
          status: result.status,
          runId: result.id,
          resultText: result.result ?? '完成',
          durationMs: result.durationMs,
        };
      }
      if (result.status === 'cancelled') {
        return {
          ok: false,
          status: 'cancelled',
          runId: result.id,
          error: result.error?.message ?? '執行已取消',
          durationMs: result.durationMs,
        };
      }
      return {
        ok: false,
        status: result.status,
        runId: result.id,
        error: result.error?.message ?? `Cursor SDK run 失敗：${result.status}`,
        durationMs: result.durationMs,
      };
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
    }
  } catch (err) {
    if (err instanceof CursorAgentError) {
      return {
        ok: false,
        status: 'error',
        error: `Cursor SDK 啟動失敗：${err.message}`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 'error', error: message };
  }
}
