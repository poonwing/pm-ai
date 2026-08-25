import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { ValidationError } from '../services/tasks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}

const CONNECT_RETRY_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export function getModelConfig() {
  return {
    apiKey: process.env.ZAI_API_KEY ?? '',
    // Coding Plan 默认走 coding 通道；按量计费请在 .env 改为 /api/paas/v4/
    baseURL: process.env.ZAI_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: process.env.ZAI_MODEL ?? 'glm-4.7',
  };
}

export function isModelConfigured(): boolean {
  return Boolean(getModelConfig().apiKey);
}

export function createChatClient() {
  const cfg = getModelConfig();
  if (!cfg.apiKey) {
    throw new ValidationError('未設定 ZAI_API_KEY（請在專案根目錄 .env 配置）');
  }
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL.replace(/\/?$/, '/'),
    timeout: 60_000,
    maxRetries: 0,
  });
}

function collectErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
    const obj = current as { name?: string; code?: string | number; cause?: unknown };
    if (obj.name) codes.push(String(obj.name));
    if (obj.code !== undefined) codes.push(String(obj.code));
    current = obj.cause;
  }
  return codes;
}

function isRetryableConnectionError(err: unknown): boolean {
  const codes = collectErrorCodes(err);
  const msg = err instanceof Error ? err.message : String(err);
  return (
    codes.includes('APIConnectionError') ||
    codes.some((code) => CONNECT_RETRY_CODES.has(code)) ||
    /fetch failed|other side closed|socket|timed? ?out/i.test(msg)
  );
}

function formatModelError(err: unknown): Error {
  const anyErr = err as {
    status?: number;
    code?: string | number;
    error?: { code?: string | number; message?: string };
    message?: string;
    name?: string;
  };
  const code = String(anyErr?.error?.code ?? anyErr?.code ?? '');
  const msg = anyErr?.error?.message ?? anyErr?.message ?? '模型调用失败';
  if (code === '1113' || msg.includes('余额不足')) {
    return new ValidationError(
      `GLM 1113 余额不足或无可用资源包。若你用的是 Coding Plan：请确认 .env 中 ZAI_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4 且 ZAI_MODEL 为 glm-4.7/glm-5.3 等套餐模型；通用 /api/paas/v4 不会走 Coding 额度。也可到智谱控制台检查套餐用量或账户余额。原始信息：${msg}`,
    );
  }
  if (isRetryableConnectionError(err)) {
    const { baseURL } = getModelConfig();
    return new ValidationError(
      `無法連上智譜 API（${baseURL}）：連線被中斷。請再試一次；若持續失敗，確認本機能訪問該網址，或把 ZAI_BASE_URL 改為 https://api.z.ai/api/coding/paas/v4。原始信息：${msg}`,
    );
  }
  return new ValidationError(msg);
}

export async function chatCompletion(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts?: { temperature?: number; json?: boolean },
): Promise<string> {
  const client = createChatClient();
  const cfg = getModelConfig();
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // GLM coding 通道对 response_format=json_object 常会长时间不回、最后把 socket 掐掉。
      // 提示词已要求 JSON；关闭思考避免静默过久被代理断开。
      const res = await client.chat.completions.create({
        model: cfg.model,
        messages,
        temperature: opts?.temperature ?? 0.4,
        thinking: { type: 'disabled' },
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
      return res.choices[0]?.message?.content ?? '';
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isRetryableConnectionError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        continue;
      }
      throw formatModelError(err);
    }
  }
  throw formatModelError(lastErr);
}
