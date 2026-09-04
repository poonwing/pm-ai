import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { getPiRunnerConfig } from './types.js';
import { isZhipuTransientNetworkError } from '../orchestrator/model.js';
import type { RunnerLogKind } from './logs.js';

export interface PiRunOutcome {
  ok: boolean;
  status: string;
  runId?: string;
  resultText?: string;
  error?: string;
  durationMs?: number;
}

type StreamOnLog = (kind: RunnerLogKind, text: string) => void;

/** 累積 streaming delta，合併成完整段落再輸出（對齊 Cursor / OpenCode runner） */
class StreamLogSink {
  private assistantBuf = '';
  private thinkingBuf = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private seenToolCalls = new Set<string>();

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
    if (text) this.onLog?.('assistant', text);
    if (final) this.assistantBuf = '';
  }

  private flushThinking(final = true) {
    const text = this.thinkingBuf.trim();
    if (text) this.onLog?.('thinking', text);
    if (final) this.thinkingBuf = '';
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

  emitTool(name: string, callId?: string) {
    const key = callId || name;
    if (this.seenToolCalls.has(key)) return;
    this.seenToolCalls.add(key);
    this.flushAll();
    this.onLog?.('tool', `🔧 ${name}`);
  }

  emitToolDone(name: string, detail?: string) {
    this.flushAll();
    const suffix = detail?.trim() ? ` — ${detail.trim().slice(0, 200)}` : '';
    this.onLog?.('tool', `✓ ${name}${suffix}`);
  }

  emitToolError(name: string, error: string) {
    this.flushAll();
    this.onLog?.('error', `${name} 失敗：${error.slice(0, 500)}`);
  }

  emitSystem(text: string) {
    this.flushAll();
    this.onLog?.('system', text);
  }

  emitError(text: string) {
    this.flushAll();
    this.onLog?.('error', text);
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractAssistantText(messages: unknown[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as { role?: string; content?: unknown; errorMessage?: string };
    if (m.role !== 'assistant') continue;
    const text = extractTextFromContent(m.content);
    if (text) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

function lastAssistantError(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (m.role !== 'assistant') continue;
    if (m.stopReason === 'error' || m.stopReason === 'aborted') {
      return m.errorMessage || m.stopReason;
    }
    break;
  }
  return undefined;
}

function handlePiEvent(event: AgentSessionEvent, sink: StreamLogSink) {
  if (event.type === 'message_update') {
    const ame = event.assistantMessageEvent as {
      type?: string;
      delta?: string;
    };
    if (ame.type === 'text_delta' && ame.delta) {
      sink.appendAssistant(ame.delta);
    } else if (
      (ame.type === 'thinking_delta' || ame.type === 'reasoning_delta') &&
      ame.delta
    ) {
      sink.appendThinking(ame.delta);
    }
    return;
  }

  if (event.type === 'tool_execution_start') {
    const e = event as { toolName?: string; toolCallId?: string };
    sink.emitTool(String(e.toolName ?? '工具'), e.toolCallId);
    return;
  }

  if (event.type === 'tool_execution_end') {
    const e = event as {
      toolName?: string;
      isError?: boolean;
      error?: string;
      result?: unknown;
    };
    const name = String(e.toolName ?? '工具');
    if (e.isError) {
      sink.emitToolError(name, String(e.error ?? 'tool error'));
      return;
    }
    const detail =
      typeof e.result === 'string'
        ? e.result
        : e.result && typeof e.result === 'object' && 'output' in (e.result as object)
          ? String((e.result as { output?: unknown }).output ?? '')
          : '';
    sink.emitToolDone(name, detail);
    return;
  }

  if (event.type === 'auto_retry_start') {
    const e = event as { attempt?: number; errorMessage?: string };
    sink.emitSystem(
      `Pi 自動重試 #${e.attempt ?? '?'}：${String(e.errorMessage ?? '').slice(0, 120)}`,
    );
    return;
  }
}

function defaultTools(): string[] {
  if (process.platform === 'win32') {
    return ['read', 'powershell', 'edit', 'write', 'bash', 'grep', 'find', 'ls'];
  }
  return ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
}

function rmDirQuiet(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export async function runPiAgentPrompt(input: {
  prompt: string;
  cwd: string;
  taskId: string;
  signal?: AbortSignal;
  onLog?: StreamOnLog;
}): Promise<PiRunOutcome> {
  const log = (kind: RunnerLogKind, text: string) => input.onLog?.(kind, text);
  const cfg = getPiRunnerConfig();
  if (!cfg.apiKey) {
    return { ok: false, status: 'error', error: '未配置 ZAI_API_KEY（Pi Agent 复用 GLM Coding Plan Key）' };
  }
  if (input.signal?.aborted) {
    return { ok: false, status: 'cancelled', error: '已取消' };
  }

  const started = Date.now();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ai-pi-'));
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  let unsub: (() => void) | null = null;

  const onAbort = () => {
    void session?.abort().catch(() => undefined);
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    log('system', `正在啟動 Pi Agent（${cfg.providerId}/${cfg.modelId}）…`);

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
    });
    await modelRuntime.setRuntimeApiKey(cfg.providerId, cfg.apiKey);

    const model = modelRuntime.getModel(cfg.providerId, cfg.modelId);
    if (!model) {
      const available = modelRuntime.getModels(cfg.providerId).map((m) => m.id);
      return {
        ok: false,
        status: 'error',
        error: `Pi 找不到模型 ${cfg.providerId}/${cfg.modelId}。可用：${available.join(', ') || '（无）'}`,
        durationMs: Date.now() - started,
      };
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      // 避免掃到使用者本機 ~/.pi；任務 prompt 已含足夠上下文
      systemPromptOverride: () =>
        `You are the PM-AI task runner powered by GLM. Complete the assigned task in the working directory using the available tools. Prefer editing existing files over creating new ones unless necessary. Be concise in final summaries.`,
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    } as ConstructorParameters<typeof DefaultResourceLoader>[0]);
    await resourceLoader.reload();

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 800 },
    });

    const created = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      model,
      thinkingLevel: cfg.thinkingLevel,
      modelRuntime,
      resourceLoader,
      tools: defaultTools(),
      sessionManager: SessionManager.inMemory(input.cwd),
      settingsManager,
    });
    session = created.session;

    const sink = new StreamLogSink(input.onLog);
    unsub = session.subscribe((event) => {
      try {
        handlePiEvent(event, sink);
      } catch {
        /* ignore stream handler errors */
      }
    });

    log('system', `Pi session 已建立：${session.sessionId}`);
    log('system', '正在發送任務 prompt…');

    const maxAttempts = Math.max(1, Number(process.env.PI_PROMPT_MAX_ATTEMPTS ?? '3') || 3);
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (input.signal?.aborted) break;
      try {
        await session.prompt(input.prompt);
        lastError = '';
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const retryable =
          isZhipuTransientNetworkError(lastError) ||
          /fetch failed|other side closed|socket|ECONNRESET|UND_ERR/i.test(lastError);
        if (attempt < maxAttempts && retryable && !input.signal?.aborted) {
          log(
            'system',
            `智譜/網絡暫態錯誤，重試 prompt ${attempt + 1}/${maxAttempts}…`,
          );
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        break;
      }
    }

    if (input.signal?.aborted) {
      return {
        ok: false,
        status: 'cancelled',
        runId: session.sessionId,
        error: '已取消',
        durationMs: Date.now() - started,
      };
    }

    sink.flushAll();
    const messages = session.messages as unknown[];
    const assistantErr = lastAssistantError(messages);
    if (lastError || assistantErr) {
      const error = lastError || assistantErr || 'Pi Agent 執行失敗';
      return {
        ok: false,
        status: 'error',
        runId: session.sessionId,
        error,
        durationMs: Date.now() - started,
      };
    }

    const text = extractAssistantText(messages) || 'Pi Agent 执行完成';
    if (text) log('assistant', text);

    return {
      ok: true,
      status: 'finished',
      runId: session.sessionId,
      resultText: text.slice(0, 8000),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (input.signal?.aborted) {
      return {
        ok: false,
        status: 'cancelled',
        runId: session?.sessionId,
        error: '已取消',
        durationMs: Date.now() - started,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 'error',
      runId: session?.sessionId,
      error: message,
      durationMs: Date.now() - started,
    };
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    try {
      unsub?.();
    } catch {
      /* ignore */
    }
    try {
      session?.dispose();
    } catch {
      /* ignore */
    }
    rmDirQuiet(agentDir);
  }
}
