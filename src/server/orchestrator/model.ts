import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}

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
    throw new Error('未設定 ZAI_API_KEY（請在專案根目錄 .env 配置）');
  }
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL.replace(/\/?$/, '/'),
  });
}

function formatModelError(err: unknown): Error {
  const anyErr = err as {
    status?: number;
    code?: string | number;
    error?: { code?: string | number; message?: string };
    message?: string;
  };
  const code = String(anyErr?.error?.code ?? anyErr?.code ?? '');
  const msg = anyErr?.error?.message ?? anyErr?.message ?? '模型调用失败';
  if (code === '1113' || msg.includes('余额不足')) {
    return new Error(
      `GLM 1113 余额不足或无可用资源包。若你用的是 Coding Plan：请确认 .env 中 ZAI_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4 且 ZAI_MODEL 为 glm-4.7/glm-5.3 等套餐模型；通用 /api/paas/v4 不会走 Coding 额度。也可到智谱控制台检查套餐用量或账户余额。原始信息：${msg}`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

export async function chatCompletion(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts?: { temperature?: number; json?: boolean },
): Promise<string> {
  const client = createChatClient();
  const cfg = getModelConfig();
  try {
    const res = await client.chat.completions.create({
      model: cfg.model,
      messages,
      temperature: opts?.temperature ?? 0.4,
      ...(opts?.json ? { response_format: { type: 'json_object' } as const } : {}),
    });
    return res.choices[0]?.message?.content ?? '';
  } catch (err) {
    throw formatModelError(err);
  }
}
