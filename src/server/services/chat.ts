import { v4 as uuidv4 } from 'uuid';
import { eq, desc, and, asc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getProject, ValidationError, NotFoundError } from './tasks.js';
import { chatCompletion, isModelConfigured } from '../orchestrator/model.js';
import { collectWorkspaceBrief } from '../orchestrator/research.js';
import {
  appendChatStream,
  updateOrAppendChatStream,
  clearChatStream,
  resetChatStream,
} from './chat-stream.js';
import {
  answerChatUserQuestion,
  cancelPendingChatQuestion,
  hasPendingChatQuestion,
} from './chat-user-input.js';
import type { ChatMode, ChatMessage, ChatSession } from '../../shared/schemas.js';

function now() {
  return new Date().toISOString();
}

function mapSession(row: typeof schema.chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    project_id: row.projectId,
    title: row.title,
    mode: (row.mode as ChatMode) || 'ask',
    status: (row.status as ChatSession['status']) || 'idle',
    provider: row.provider,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function mapMessage(row: typeof schema.chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    session_id: row.sessionId,
    role: row.role as ChatMessage['role'],
    content: row.content,
    kind: (row.kind as ChatMessage['kind']) || 'text',
    at: row.at,
  };
}

function touchSession(
  sessionId: string,
  patch: Partial<{
    title: string;
    mode: string;
    status: string;
    provider: string | null;
  }>,
) {
  const db = getDb();
  db.update(schema.chatSessions)
    .set({ ...patch, updatedAt: now() })
    .where(eq(schema.chatSessions.id, sessionId))
    .run();
}

export function listChatSessions(projectId: string): ChatSession[] {
  getProject(projectId);
  const rows = getDb()
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.projectId, projectId))
    .orderBy(desc(schema.chatSessions.updatedAt))
    .all();
  return rows.map(mapSession);
}

export function getChatSession(projectId: string, sessionId: string): ChatSession {
  const row = getDb()
    .select()
    .from(schema.chatSessions)
    .where(
      and(eq(schema.chatSessions.id, sessionId), eq(schema.chatSessions.projectId, projectId)),
    )
    .get();
  if (!row) throw new NotFoundError('對話不存在');
  return mapSession(row);
}

export function createChatSession(
  projectId: string,
  input?: { title?: string; mode?: ChatMode },
): ChatSession {
  getProject(projectId);
  const id = uuidv4();
  const at = now();
  const mode = input?.mode ?? 'ask';
  getDb()
    .insert(schema.chatSessions)
    .values({
      id,
      projectId,
      title: input?.title?.trim() || '新對話',
      mode,
      status: 'idle',
      provider: null,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return getChatSession(projectId, id);
}

export function deleteChatSession(projectId: string, sessionId: string) {
  getChatSession(projectId, sessionId);
  cancelPendingChatQuestion(sessionId, '對話已刪除');
  const db = getDb();
  db.delete(schema.chatMessages).where(eq(schema.chatMessages.sessionId, sessionId)).run();
  db.delete(schema.chatSessions).where(eq(schema.chatSessions.id, sessionId)).run();
  clearChatStream(sessionId);
  return { deleted: true, id: sessionId };
}

export function listChatMessages(projectId: string, sessionId: string): ChatMessage[] {
  getChatSession(projectId, sessionId);
  return getDb()
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(asc(schema.chatMessages.at))
    .all()
    .map(mapMessage);
}

function appendMessage(
  sessionId: string,
  role: ChatMessage['role'],
  content: string,
  kind: ChatMessage['kind'] = 'text',
): ChatMessage {
  const id = uuidv4();
  const at = now();
  getDb()
    .insert(schema.chatMessages)
    .values({
      id,
      sessionId,
      role,
      content,
      kind,
      at,
    })
    .run();
  touchSession(sessionId, {});
  return {
    id,
    session_id: sessionId,
    role,
    content,
    kind,
    at,
  };
}

function titleFromMessage(message: string): string {
  const t = message.trim().replace(/\s+/g, ' ');
  return t.length > 36 ? `${t.slice(0, 36)}…` : t || '新對話';
}

function buildAskSystemPrompt(project: ReturnType<typeof getProject>): string {
  const brief = collectWorkspaceBrief(project.workspacePath);
  return `你是 PM-AI 工作區助手（Ask 模式）。
專案：${project.name}
路徑：${project.workspacePath}
${project.description ? `描述：${project.description}` : ''}

工作區摘要（只讀參考）：
${brief.slice(0, 10000)}

規則：
- 用繁體中文回答，簡潔準確。
- 這是 Ask 模式：只能分析與建議，不要假裝已修改檔案。
- 若用戶要改代碼，建議切換到 Agent 模式。
- 不確定時請明確說明。`;
}

async function runAskTurn(projectId: string, sessionId: string, userText: string) {
  const project = getProject(projectId);
  if (!isModelConfigured()) {
    throw new ValidationError('未配置 ZAI_API_KEY，Ask 模式無法使用內部模型');
  }

  touchSession(sessionId, { status: 'streaming', provider: 'zai' });
  appendChatStream(sessionId, 'status', 'streaming');

  const history = listChatMessages(projectId, sessionId)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-16);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: buildAskSystemPrompt(project) },
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const assistantId = uuidv4();
  try {
    const reply = await chatCompletion(messages, {
      temperature: 0.4,
      timeoutMs: 120_000,
      maxAttempts: 2,
    });
    const text = reply.trim() || '（模型未返回內容）';
    updateOrAppendChatStream(sessionId, 'assistant', text, assistantId);

    getDb()
      .insert(schema.chatMessages)
      .values({
        id: assistantId,
        sessionId,
        role: 'assistant',
        content: text,
        kind: 'text',
        at: now(),
      })
      .run();
    touchSession(sessionId, { status: 'idle', provider: 'zai' });
    appendChatStream(sessionId, 'status', 'idle', assistantId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendMessage(sessionId, 'system', msg, 'error');
    appendChatStream(sessionId, 'error', msg);
    touchSession(sessionId, { status: 'error', provider: 'zai' });
    appendChatStream(sessionId, 'status', 'error');
  }
}

function buildAgentPrompt(
  project: ReturnType<typeof getProject>,
  history: ChatMessage[],
  userText: string,
): string {
  const prior = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n');

  return [
    '你是 PM-AI 工作區 Agent（Agent 模式）。',
    `專案：${project.name}`,
    `工作目錄：${project.workspacePath}`,
    project.description ? `描述：${project.description}` : '',
    '',
    '你可以讀寫當前工作目錄內與任務相關的檔案，並執行必要命令。',
    '不要修改 .pm-ai/ 任務帳本（除非用戶明確要求）。',
    '若需要用戶澄清、選擇或確認，請呼叫 ask_user 工具並等待回覆；不要只在文字裡提問後停住。',
    '完成後用繁體中文簡要說明你做了什麼。',
    '',
    prior ? `—— 近期對話 ——\n${prior}` : '',
    '',
    `—— 本輪用戶請求 ——\n${userText}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Runner 透過 ask_user / request 向用戶提問時呼叫 */
export async function notifyChatAwaitingUser(
  sessionId: string,
  question: string,
  options?: string[],
) {
  const row = getDb()
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId))
    .get();
  if (!row) return;

  const lines = [question.trim()];
  if (options?.length) {
    lines.push('', '選項：');
    options.forEach((opt, i) => lines.push(`${i + 1}. ${opt}`));
  }
  const text = lines.filter(Boolean).join('\n');
  const msg = appendMessage(sessionId, 'assistant', text, 'question');
  appendChatStream(sessionId, 'question', text, msg.id);
  touchSession(sessionId, { status: 'awaiting_user' });
  appendChatStream(sessionId, 'status', 'awaiting_user', msg.id);
}

/** 提問結束／失效時清掉 awaiting_user，避免 UI 卡死 */
export function clearChatAwaitingUser(
  sessionId: string,
  nextStatus: 'running' | 'idle' = 'running',
) {
  const row = getDb()
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId))
    .get();
  if (!row || row.status !== 'awaiting_user') return;
  touchSession(sessionId, { status: nextStatus });
  appendChatStream(sessionId, 'status', nextStatus);
}

async function runAgentTurn(projectId: string, sessionId: string, userText: string) {
  const project = getProject(projectId);
  const { resolveRunnerProvider, enqueueRunnerJob, runnerProviderLabel } = await import(
    '../runner/index.js'
  );
  const provider = resolveRunnerProvider(projectId);
  const history = listChatMessages(projectId, sessionId);
  const prompt = buildAgentPrompt(project, history, userText);

  touchSession(sessionId, { status: 'running', provider });
  appendChatStream(sessionId, 'status', 'running');
  appendChatStream(sessionId, 'system', `已交給 ${runnerProviderLabel(provider)} 執行…`);

  const job = enqueueRunnerJob({
    projectId,
    kind: 'chat',
    chatSessionId: sessionId,
    taskId: `CHAT-${sessionId.slice(0, 8)}`,
    prompt,
    cwd: project.workspacePath,
  });

  if (job.status === 'failed') {
    const err = job.error ?? 'Runner 無法啟動';
    appendMessage(sessionId, 'system', err, 'error');
    appendChatStream(sessionId, 'error', err);
    touchSession(sessionId, { status: 'error', provider });
    appendChatStream(sessionId, 'status', 'error');
  }
}

/** Runner chat job 結束後回寫 */
export function recordChatJobFinished(job: {
  projectId: string;
  chatSessionId?: string | null;
  status: string;
  resultSummary?: string | null;
  error?: string | null;
  provider?: string | null;
}) {
  const sessionId = job.chatSessionId;
  if (!sessionId) return;
  try {
    getChatSession(job.projectId, sessionId);
  } catch {
    return;
  }

  if (job.status === 'completed') {
    const text = (job.resultSummary ?? 'Agent 已完成。').trim();
    const msg = appendMessage(sessionId, 'assistant', text, 'text');
    updateOrAppendChatStream(sessionId, 'assistant', text, msg.id);
    touchSession(sessionId, {
      status: 'idle',
      provider: job.provider ?? null,
    });
    appendChatStream(sessionId, 'status', 'idle', msg.id);
  } else if (job.status === 'cancelled') {
    const text = job.error ?? '已取消';
    appendMessage(sessionId, 'system', text, 'system');
    appendChatStream(sessionId, 'system', text);
    touchSession(sessionId, { status: 'idle', provider: job.provider ?? null });
    appendChatStream(sessionId, 'status', 'idle');
  } else {
    const text = job.error ?? 'Agent 執行失敗';
    appendMessage(sessionId, 'system', text, 'error');
    appendChatStream(sessionId, 'error', text);
    touchSession(sessionId, { status: 'error', provider: job.provider ?? null });
    appendChatStream(sessionId, 'status', 'error');
  }
}

export async function sendChatMessage(
  projectId: string,
  sessionId: string,
  input: { message: string; mode?: ChatMode },
): Promise<{ session: ChatSession; messages: ChatMessage[] }> {
  const session = getChatSession(projectId, sessionId);

  const text = input.message.trim();
  if (!text) throw new ValidationError('訊息不可為空');

  // Agent 提問中：把本則訊息當回答，恢復 Runner（以 pending 為準，不單看 status）
  if (hasPendingChatQuestion(sessionId)) {
    appendMessage(sessionId, 'user', text, 'text');
    const ok = answerChatUserQuestion(sessionId, text);
    if (!ok) {
      throw new ValidationError('目前沒有待回答的問題');
    }
    touchSession(sessionId, { status: 'running' });
    appendChatStream(sessionId, 'status', 'running');
    appendChatStream(sessionId, 'system', '已收到回覆，Agent 繼續執行…');
    return {
      session: getChatSession(projectId, sessionId),
      messages: listChatMessages(projectId, sessionId),
    };
  }

  if (session.status === 'streaming' || session.status === 'running') {
    throw new ValidationError('此對話仍在回覆中，請稍候');
  }

  // DB 仍是 awaiting_user，但記憶體 pending 已丟（常見於服務熱重載）
  // → 清掉僵死狀態，把本則當新一輪請求繼續，不再報錯卡住
  if (session.status === 'awaiting_user') {
    clearChatAwaitingUser(sessionId, 'idle');
    appendChatStream(
      sessionId,
      'system',
      '上一輪提問已失效（服務可能已重啟），改以新請求繼續…',
    );
  }

  const mode = input.mode ?? session.mode;
  if (mode !== session.mode) {
    touchSession(sessionId, { mode });
  }

  const msgCount = listChatMessages(projectId, sessionId).length;
  if (msgCount === 0 || session.title === '新對話') {
    touchSession(sessionId, { title: titleFromMessage(text) });
  }

  appendMessage(sessionId, 'user', text, 'text');

  // 新一輪開始時清掉上一輪 SSE buffer，避免 client 用 since_seq=0 回放舊回覆，
  // 讓新的用戶訊息看起來插在舊 agent 回覆上面。
  resetChatStream(sessionId);

  // Mark busy before returning so SSE clients don't race with idle status.
  touchSession(sessionId, {
    status: mode === 'agent' ? 'running' : 'streaming',
    mode,
  });
  appendChatStream(sessionId, 'status', mode === 'agent' ? 'running' : 'streaming');

  // Fire and forget so HTTP can return quickly; client uses SSE for progress.
  void (mode === 'agent' ? runAgentTurn(projectId, sessionId, text) : runAskTurn(projectId, sessionId, text));

  return {
    session: getChatSession(projectId, sessionId),
    messages: listChatMessages(projectId, sessionId),
  };
}

export function updateChatSessionMode(
  projectId: string,
  sessionId: string,
  mode: ChatMode,
): ChatSession {
  getChatSession(projectId, sessionId);
  touchSession(sessionId, { mode });
  return getChatSession(projectId, sessionId);
}
