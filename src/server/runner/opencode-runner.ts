import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createOpencodeClient, type Part } from '@opencode-ai/sdk';
import { ensureOpenCodeCliOnPath, OPENCODE_CLI_INSTALL_HINT } from './opencode-cli.js';
import { getOpenCodeRunnerConfig } from './types.js';

export interface OpenCodeRunOutcome {
  ok: boolean;
  status: string;
  runId?: string;
  resultText?: string;
  error?: string;
  durationMs?: number;
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
}): Promise<OpenCodeRunOutcome> {
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

    const prompted = await client.session.prompt({
      path: { id: sessionId },
      query: { directory: input.cwd },
      body: {
        model: { providerID: cfg.providerId, modelID: cfg.modelId },
        parts: [{ type: 'text', text: input.prompt }],
      },
    });

    if (input.signal?.aborted) {
      return {
        ok: false,
        status: 'cancelled',
        runId: sessionId,
        error: '已取消',
        durationMs: Date.now() - started,
      };
    }

    if (prompted.error || !prompted.data) {
      const msg =
        (prompted.error as { message?: string } | undefined)?.message ??
        'OpenCode session.prompt 失败';
      return {
        ok: false,
        status: 'error',
        runId: sessionId,
        error: msg,
        durationMs: Date.now() - started,
      };
    }

    const info = prompted.data.info;
    if (info.error) {
      const errObj = info.error as { message?: string; name?: string; data?: { message?: string } };
      const errMsg =
        errObj.message || errObj.data?.message || errObj.name || 'OpenCode 执行错误';
      return {
        ok: false,
        status: 'error',
        runId: sessionId,
        error: errMsg,
        durationMs: Date.now() - started,
      };
    }

    const text = extractText(prompted.data.parts) || 'OpenCode 执行完成';
    return {
      ok: true,
      status: 'finished',
      runId: sessionId,
      resultText: text.slice(0, 8000),
      durationMs: Date.now() - started,
    };
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
