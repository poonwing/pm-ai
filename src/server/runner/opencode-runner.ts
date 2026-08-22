import net from 'net';
import {
  createOpencodeClient,
  createOpencodeServer,
  type Part,
} from '@opencode-ai/sdk';
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
    server = await createOpencodeServer({
      hostname: '127.0.0.1',
      port,
      timeout: Math.max(5_000, Number(process.env.OPENCODE_SERVER_TIMEOUT_MS ?? '20000') || 20_000),
      signal: input.signal,
      config: buildOpenCodeConfig(),
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
    const hint = /ENOENT|not found|opencode/i.test(message)
      ? `OpenCode SDK 需要本机已安装 opencode CLI（PATH 中可执行）。原始错误：${message}`
      : message;
    return {
      ok: false,
      status: 'error',
      runId: sessionId ?? undefined,
      error: hint,
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
