import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import {
  createOpencodeClient,
  type Event,
  type Part,
} from '@opencode-ai/sdk';
import { ensureOpenCodeCliOnPath, OPENCODE_CLI_INSTALL_HINT } from './opencode-cli.js';
import { getOpenCodeRunnerConfig } from './types.js';
import { isZhipuTransientNetworkError } from '../orchestrator/model.js';
import type { RunnerLogKind } from './logs.js';

export interface OpenCodeRunOutcome {
  ok: boolean;
  status: string;
  runId?: string;
  resultText?: string;
  error?: string;
  durationMs?: number;
}

type StreamOnLog = (kind: RunnerLogKind, text: string) => void;

/** 累積 streaming delta，合併成完整段落再輸出（對齊 Cursor runner） */
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

  setAssistant(text: string) {
    if (!text) return;
    if (this.thinkingBuf) {
      this.cancelDebounce();
      this.flushThinking(true);
    }
    this.assistantBuf = text;
    this.scheduleFlush();
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

  setThinking(text: string) {
    if (!text) return;
    if (this.assistantBuf) {
      this.cancelDebounce();
      this.flushAssistant(true);
    }
    this.thinkingBuf = text;
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

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('无法分配本地端口'));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function extractText(parts: Part[] | undefined): string {
  if (!parts?.length) return '';
  return parts
    .map((p) => {
      if (p.type === 'text' && 'text' in p && typeof p.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function eventSessionId(event: Event): string | undefined {
  const props = 'properties' in event ? (event.properties as Record<string, unknown>) : undefined;
  if (!props) return undefined;
  if (typeof props.sessionID === 'string') return props.sessionID;
  const part = props.part;
  if (part && typeof part === 'object' && 'sessionID' in part) {
    const sid = (part as { sessionID?: unknown }).sessionID;
    if (typeof sid === 'string') return sid;
  }
  const info = props.info;
  if (info && typeof info === 'object' && 'id' in info && event.type.startsWith('session.')) {
    const id = (info as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function handleOpenCodePart(
  part: Part,
  delta: string | undefined,
  sink: StreamLogSink,
  assistantMsgIds: Set<string>,
  userMsgIds: Set<string>,
  pendingText: Map<string, string>,
) {
  if (part.type === 'text') {
    if (part.synthetic) return;
    if (userMsgIds.has(part.messageID)) {
      pendingText.delete(part.messageID);
      return;
    }

    if (assistantMsgIds.has(part.messageID)) {
      pendingText.delete(part.messageID);
      if (typeof delta === 'string' && delta.length > 0) {
        sink.appendAssistant(delta);
      } else if (part.text) {
        sink.setAssistant(part.text);
      }
      return;
    }

    // 尚不知 role：先緩存，等 message.updated 確認是 assistant 再開閘
    if (typeof delta === 'string' && delta.length > 0) {
      pendingText.set(part.messageID, (pendingText.get(part.messageID) ?? '') + delta);
    } else if (part.text) {
      pendingText.set(part.messageID, part.text);
    }
    return;
  }

  if (part.type === 'reasoning') {
    if (typeof delta === 'string' && delta.length > 0) {
      sink.appendThinking(delta);
    } else if (part.text) {
      sink.setThinking(part.text);
    }
    return;
  }

  if (part.type === 'tool') {
    const name = part.tool || 'tool';
    const state = part.state;
    if (state.status === 'pending' || state.status === 'running') {
      sink.emitTool(name, part.callID);
    } else if (state.status === 'completed') {
      sink.emitTool(name, part.callID);
      sink.emitToolDone(name, state.title || undefined);
    } else if (state.status === 'error') {
      sink.emitTool(name, part.callID);
      sink.emitToolError(name, state.error || 'unknown');
    }
    return;
  }

  if (part.type === 'patch' && part.files?.length) {
    sink.emitSystem(`已修改：${part.files.slice(0, 8).join(', ')}`);
    return;
  }

  if (part.type === 'retry') {
    sink.emitSystem(`模型重試 #${part.attempt}…`);
  }
}

function handleOpenCodeEvent(
  event: Event,
  sessionId: string,
  sink: StreamLogSink,
  assistantMsgIds: Set<string>,
  userMsgIds: Set<string>,
  pendingText: Map<string, string>,
) {
  // Isolated server 只有我們一個 session；file.edited 無 sessionID，仍顯示。
  const sid = eventSessionId(event);
  if (sid && sid !== sessionId) return;

  switch (event.type) {
    case 'message.updated': {
      const info = event.properties.info;
      if (info.role === 'assistant') {
        assistantMsgIds.add(info.id);
        const buffered = pendingText.get(info.id);
        if (buffered) {
          pendingText.delete(info.id);
          sink.setAssistant(buffered);
        }
      } else if (info.role === 'user') {
        userMsgIds.add(info.id);
        pendingText.delete(info.id);
      }
      return;
    }
    case 'message.part.updated': {
      handleOpenCodePart(
        event.properties.part,
        event.properties.delta,
        sink,
        assistantMsgIds,
        userMsgIds,
        pendingText,
      );
      return;
    }
    case 'file.edited': {
      sink.emitSystem(`已編輯：${event.properties.file}`);
      return;
    }
    case 'session.status': {
      const status = event.properties.status;
      if (status.type === 'retry') {
        sink.emitSystem(`重試中（#${status.attempt}）：${status.message}`);
      }
      return;
    }
    case 'session.error': {
      const err = event.properties.error as
        | { message?: string; name?: string; data?: { message?: string } }
        | undefined;
      const msg = err?.data?.message || err?.message || err?.name || 'OpenCode session 錯誤';
      sink.emitError(msg);
      return;
    }
    case 'session.idle':
      sink.flushAll();
      return;
    default:
      return;
  }
}

async function consumeOpenCodeEventStream(input: {
  stream: AsyncIterable<Event>;
  sessionId: string;
  signal?: AbortSignal;
  sink: StreamLogSink;
}): Promise<void> {
  const assistantMsgIds = new Set<string>();
  const userMsgIds = new Set<string>();
  const pendingText = new Map<string, string>();
  try {
    for await (const event of input.stream) {
      if (input.signal?.aborted) break;
      handleOpenCodeEvent(
        event,
        input.sessionId,
        input.sink,
        assistantMsgIds,
        userMsgIds,
        pendingText,
      );
    }
  } catch (err) {
    if (input.signal?.aborted) return;
    // SSE 結束／伺服器關閉屬預期；其他錯誤僅記一筆，不讓主流程失敗
    const msg = err instanceof Error ? err.message : String(err);
    if (!/aborted|abort|ECONNRESET|socket hang up/i.test(msg)) {
      input.sink.emitSystem(`事件流結束：${msg.slice(0, 200)}`);
    }
  } finally {
    input.sink.flushAll();
  }
}

function buildOpenCodeConfig() {
  const cfg = getOpenCodeRunnerConfig();
  return {
    model: cfg.modelRef,
    provider: {
      [cfg.providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Zhipu GLM (PM-AI)',
        options: {
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
        },
        models: {
          [cfg.modelId]: { name: cfg.modelId },
        },
      },
    },
    permission: {
      edit: 'allow' as const,
      bash: 'allow' as const,
      webfetch: 'allow' as const,
      external_directory: 'allow' as const,
    },
  };
}

export async function runOpenCodePrompt(input: {
  prompt: string;
  cwd: string;
  taskId: string;
  signal?: AbortSignal;
  onLog?: (kind: RunnerLogKind, text: string) => void;
}): Promise<OpenCodeRunOutcome> {
  const log = (kind: RunnerLogKind, text: string) => input.onLog?.(kind, text);
  const cfg = getOpenCodeRunnerConfig();
  if (!cfg.apiKey) {
    return { ok: false, status: 'error', error: '未配置 ZAI_API_KEY（OpenCode 复用 GLM Key）' };
  }
  const cli = ensureOpenCodeCliOnPath();
  if (!cli.ok) {
    return { ok: false, status: 'error', error: cli.error };
  }
  if (input.signal?.aborted) {
    return { ok: false, status: 'cancelled', error: '已取消' };
  }

  const started = Date.now();
  let server: { url: string; close(): void } | null = null;
  let sessionId: string | null = null;
  let client: ReturnType<typeof createOpencodeClient> | null = null;

  const onAbort = () => {
    if (sessionId && client) {
      void client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
    }
    try {
      server?.close();
    } catch {
      /* ignore */
    }
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    log('system', '正在啟動 OpenCode 服務…');
    // Ensure child `opencode serve` can read GLM key from env as well.
    process.env.ZAI_API_KEY = cfg.apiKey;
    process.env.ZHIPU_API_KEY = cfg.apiKey;

    const port = await allocatePort();
    server = await createIsolatedOpencodeServer({
      hostname: '127.0.0.1',
      port,
      timeout: Math.max(5_000, Number(process.env.OPENCODE_SERVER_TIMEOUT_MS ?? '20000') || 20_000),
      signal: input.signal,
      config: buildOpenCodeConfig(),
      bin: cli.bin,
    });

    client = createOpencodeClient({
      baseUrl: server.url,
      directory: input.cwd,
    });

    await client.auth.set({
      path: { id: cfg.providerId },
      body: { type: 'api', key: cfg.apiKey },
    });

    const created = await client.session.create({
      body: { title: `pm-ai-${input.taskId}` },
      query: { directory: input.cwd },
    });
    if (created.error || !created.data) {
      const msg =
        (created.error as { message?: string } | undefined)?.message ??
        'OpenCode session.create 失败';
      return {
        ok: false,
        status: 'error',
        error: msg,
        durationMs: Date.now() - started,
      };
    }

    sessionId = created.data.id;
    log('system', `OpenCode session 已建立：${sessionId}`);

    const sink = new StreamLogSink(input.onLog);
    const streamAc = new AbortController();
    const onParentAbort = () => streamAc.abort();
    input.signal?.addEventListener('abort', onParentAbort, { once: true });

    // 先訂閱 SSE，再發 prompt，避免漏掉早期 tool / text 事件
    log('system', '正在訂閱 OpenCode 事件流…');
    const sub = await client.event.subscribe({
      query: { directory: input.cwd },
      signal: streamAc.signal,
    });
    const eventsTask = consumeOpenCodeEventStream({
      stream: sub.stream,
      sessionId,
      signal: streamAc.signal,
      sink,
    });

    log('system', '正在發送任務 prompt…');
    const maxPromptAttempts = Math.max(
      1,
      Number(process.env.OPENCODE_PROMPT_MAX_ATTEMPTS ?? '3') || 3,
    );
    let prompted: Awaited<ReturnType<typeof client.session.prompt>> | null = null;
    let lastPromptError = '';

    try {
      for (let attempt = 1; attempt <= maxPromptAttempts; attempt++) {
        if (input.signal?.aborted) break;
        prompted = await client.session.prompt({
          path: { id: sessionId },
          query: { directory: input.cwd },
          body: {
            model: { providerID: cfg.providerId, modelID: cfg.modelId },
            parts: [{ type: 'text', text: input.prompt }],
          },
        });

        if (input.signal?.aborted) break;

        const promptErr = (prompted as { error?: { message?: string }; data?: unknown }).error;
        if (promptErr || !prompted.data) {
          lastPromptError = promptErr?.message ?? 'OpenCode session.prompt 失败';
          if (attempt < maxPromptAttempts && isZhipuTransientNetworkError(lastPromptError)) {
            log(
              'system',
              `智譜暫態網絡錯誤，重試 prompt ${attempt + 1}/${maxPromptAttempts}…`,
            );
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          return {
            ok: false,
            status: 'error',
            runId: sessionId,
            error: lastPromptError,
            durationMs: Date.now() - started,
          };
        }

        const info = prompted.data.info;
        if (info.error) {
          const errObj = info.error as {
            message?: string;
            name?: string;
            data?: { message?: string };
          };
          lastPromptError =
            errObj.message || errObj.data?.message || errObj.name || 'OpenCode 执行错误';
          if (attempt < maxPromptAttempts && isZhipuTransientNetworkError(lastPromptError)) {
            log(
              'system',
              `智譜暫態網絡錯誤（${lastPromptError.slice(0, 80)}），重試 prompt ${attempt + 1}/${maxPromptAttempts}…`,
            );
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }
          return {
            ok: false,
            status: 'error',
            runId: sessionId,
            error: lastPromptError,
            durationMs: Date.now() - started,
          };
        }

        lastPromptError = '';
        break;
      }

      if (input.signal?.aborted) {
        return {
          ok: false,
          status: 'cancelled',
          runId: sessionId,
          error: '已取消',
          durationMs: Date.now() - started,
        };
      }

      if (!prompted?.data || lastPromptError) {
        return {
          ok: false,
          status: 'error',
          runId: sessionId,
          error: lastPromptError || 'OpenCode session.prompt 失败',
          durationMs: Date.now() - started,
        };
      }

      sink.flushAll();
      const text = extractText(prompted.data.parts) || 'OpenCode 执行完成';
      // 若事件流已推過 assistant 文字，仍再推一次完整結果，方便 updateOrAppend 對齊最終版
      if (text) log('assistant', text);
      return {
        ok: true,
        status: 'finished',
        runId: sessionId,
        resultText: text.slice(0, 8000),
        durationMs: Date.now() - started,
      };
    } finally {
      streamAc.abort();
      input.signal?.removeEventListener('abort', onParentAbort);
      await Promise.race([
        eventsTask.catch(() => undefined),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }
  } catch (err) {
    if (input.signal?.aborted) {
      return {
        ok: false,
        status: 'cancelled',
        runId: sessionId ?? undefined,
        error: '已取消',
        durationMs: Date.now() - started,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 'error',
      runId: sessionId ?? undefined,
      error: formatOpenCodeLaunchError(message),
      durationMs: Date.now() - started,
    };
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    try {
      server?.close();
    } catch {
      /* ignore */
    }
  }
}

function formatOpenCodeLaunchError(message: string): string {
  if (/ENOENT|not found/i.test(message)) {
    return `${OPENCODE_CLI_INSTALL_HINT} 原始错误：${message}`;
  }
  if (/CREATE TABLE [`']workspace[`']|Failed query: CREATE TABLE/i.test(message)) {
    return `OpenCode 启动失败：多个 opencode 进程同时初始化共享数据库（~/.local/share/opencode/opencode.db），建表迁移冲突。请重试；PM-AI 已改为每个任务使用独立数据目录，且 OpenCode 默认串行执行。原始错误：${message}`;
  }
  return message;
}

function stopProc(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
}

function bindAbort(proc: ChildProcess, signal: AbortSignal | undefined, onAbort?: () => void) {
  if (!signal) return () => undefined;
  const abort = () => {
    clear();
    stopProc(proc);
    onAbort?.();
  };
  const clear = () => {
    signal.removeEventListener('abort', abort);
    proc.off('exit', clear);
    proc.off('error', clear);
  };
  signal.addEventListener('abort', abort, { once: true });
  proc.on('exit', clear);
  proc.on('error', clear);
  if (signal.aborted) abort();
  return clear;
}

/**
 * 每个任务用独立 XDG_DATA_HOME，避免并发 `opencode serve` 抢同一份 sqlite
 * 在 CREATE TABLE workspace 时互相踩踏。
 */
function createIsolatedOpencodeServer(options: {
  hostname: string;
  port: number;
  timeout: number;
  signal?: AbortSignal;
  config: ReturnType<typeof buildOpenCodeConfig>;
  bin: string;
}): Promise<{ url: string; close(): void }> {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ai-opencode-'));
  fs.mkdirSync(path.join(dataHome, 'opencode'), { recursive: true });

  const args = ['serve', `--hostname=${options.hostname}`, `--port=${options.port}`];
  // Windows：Node CVE-2024-27980 后直接 spawn .cmd/.bat 会报 spawn EINVAL，需 shell:true
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.bin);
  const proc = spawn(options.bin, args, {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: path.join(dataHome, 'state'),
    },
    shell: needsShell,
    windowsHide: true,
  });

  const cleanup = () => {
    try {
      fs.rmSync(dataHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return new Promise((resolve, reject) => {
    let clear: () => void = () => undefined;
    const timer = setTimeout(() => {
      clear();
      stopProc(proc);
      cleanup();
      reject(new Error(`Timeout waiting for server to start after ${options.timeout}ms`));
    }, options.timeout);

    let output = '';
    let resolved = false;

    proc.stdout?.on('data', (chunk) => {
      if (resolved) return;
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (!line.startsWith('opencode server listening')) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          clear();
          stopProc(proc);
          cleanup();
          clearTimeout(timer);
          reject(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        clearTimeout(timer);
        resolved = true;
        resolve({
          url: match[1],
          close() {
            clear();
            stopProc(proc);
            cleanup();
          },
        });
        return;
      }
    });

    proc.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.on('exit', (code) => {
      if (resolved) return;
      clearTimeout(timer);
      cleanup();
      let msg = `Server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    clear = bindAbort(proc, options.signal, () => {
      clearTimeout(timer);
      cleanup();
      reject(options.signal?.reason);
    });
  });
}
