import { Agent, CursorAgentError } from '@cursor/sdk';
import { getCursorRunnerConfig } from './types.js';
import type { RunnerLogKind } from './logs.js';

export interface CursorSdkRunOutcome {
  ok: boolean;
  status: string;
  runId?: string;
  resultText?: string;
  error?: string;
  durationMs?: number;
}

type StreamOnLog = (kind: RunnerLogKind, text: string) => void;

/** 累積 streaming delta，合併成完整段落再輸出 */
class StreamLogSink {
  private assistantBuf = '';
  private thinkingBuf = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private onLog?: StreamOnLog) {}

  private scheduleFlush() {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flushAssistant(false);
      this.flushThinking(false);
    }, 400);
  }

  private cancelDebounce() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private flushAssistant(final = true) {
    const text = this.assistantBuf.trim();
    if (text) {
      this.onLog?.('assistant', text);
    }
    if (final) {
      this.assistantBuf = '';
    }
  }

  private flushThinking(final = true) {
    const text = this.thinkingBuf.trim();
    if (text) {
      this.onLog?.('thinking', text);
    }
    if (final) {
      this.thinkingBuf = '';
    }
  }

  flushAll() {
    this.cancelDebounce();
    this.flushAssistant(true);
    this.flushThinking(true);
  }

  appendAssistant(delta: string) {
    if (!delta) return;
    if (this.thinkingBuf) {
      this.cancelDebounce();
      this.flushThinking(true);
    }
    this.assistantBuf += delta;
    this.scheduleFlush();
  }

  appendThinking(delta: string) {
    if (!delta) return;
    if (this.assistantBuf) {
      this.cancelDebounce();
      this.flushAssistant(true);
    }
    this.thinkingBuf += delta;
    this.scheduleFlush();
  }

  emitTool(name: string) {
    this.flushAll();
    this.onLog?.('tool', `🔧 ${name}`);
  }

  emitSystem(text: string) {
    this.flushAll();
    this.onLog?.('system', text);
  }
}

function extractTextDelta(block: { type?: string; text?: string }): string {
  const blockType = String(block.type ?? '');
  if (blockType !== 'text' || !block.text) return '';
  return block.text;
}

function emitStreamEvent(event: unknown, sink: StreamLogSink) {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  const type = String(e.type ?? '');

  if (type === 'assistant') {
    const message = e.message as
      | { content?: Array<{ type?: string; text?: string; name?: string; toolName?: string }> }
      | undefined;
    for (const block of message?.content ?? []) {
      const blockType = String(block.type ?? '');
      if (blockType === 'text') {
        const delta = extractTextDelta(block);
        if (delta) sink.appendAssistant(delta);
      } else if (blockType === 'tool_call' || blockType === 'tool_use' || blockType === 'tool') {
        const name = block.name ?? block.toolName ?? '工具';
        sink.emitTool(String(name));
      }
    }
    return;
  }

  if (type === 'thinking' || type === 'reasoning') {
    const delta =
      typeof e.text === 'string'
        ? e.text
        : typeof e.content === 'string'
          ? e.content
          : typeof e.delta === 'string'
            ? e.delta
            : '';
    if (delta) sink.appendThinking(delta);
    return;
  }

  if (type === 'system') {
    const text = typeof e.text === 'string' ? e.text : typeof e.message === 'string' ? e.message : '';
    if (text) sink.emitSystem(text);
  }
}

async function consumeRunStream(
  run: { stream?: () => AsyncIterable<unknown> },
  onLog?: StreamOnLog,
) {
  if (typeof run.stream !== 'function') return;
  const sink = new StreamLogSink(onLog);
  try {
    for await (const event of run.stream()) {
      emitStreamEvent(event, sink);
    }
  } catch {
    /* stream errors are non-fatal */
  } finally {
    sink.flushAll();
  }
}

export async function runCursorSdkPrompt(input: {
  prompt: string;
  cwd: string;
  name?: string;
  signal?: AbortSignal;
  onLog?: StreamOnLog;
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
      const [result] = await Promise.all([
        run.wait(),
        consumeRunStream(run, input.onLog),
      ]);
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
