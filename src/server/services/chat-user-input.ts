/** Agent Chat：Runner 向用戶提問並等待回覆（Pi ask_user / Cursor request） */

export interface ChatUserQuestion {
  question: string;
  options?: string[];
  askedAt: string;
}

type PendingAsk = ChatUserQuestion & {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
};

const pendingBySession = new Map<string, PendingAsk>();

export function getPendingChatQuestion(sessionId: string): ChatUserQuestion | null {
  const p = pendingBySession.get(sessionId);
  if (!p) return null;
  return {
    question: p.question,
    options: p.options,
    askedAt: p.askedAt,
  };
}

export function hasPendingChatQuestion(sessionId: string): boolean {
  return pendingBySession.has(sessionId);
}

/**
 * Runner 呼叫：發布問題並阻塞直到用戶回答或 abort。
 * 同一 session 同時只允許一個 pending question。
 */
export function waitForChatUserAnswer(
  sessionId: string,
  input: { question: string; options?: string[]; signal?: AbortSignal },
): Promise<string> {
  const question = input.question.trim();
  if (!question) {
    return Promise.reject(new Error('問題不可為空'));
  }

  const existing = pendingBySession.get(sessionId);
  if (existing) {
    existing.reject(new Error('已被新的提問取代'));
    pendingBySession.delete(sessionId);
  }

  return new Promise<string>((resolve, reject) => {
    const entry: PendingAsk = {
      question,
      options: input.options?.filter((o) => o.trim()).map((o) => o.trim()),
      askedAt: new Date().toISOString(),
      resolve: (answer) => {
        cleanup();
        resolve(answer);
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
    };

    const onAbort = () => {
      entry.reject(new Error('已取消'));
    };

    const cleanup = () => {
      input.signal?.removeEventListener('abort', onAbort);
      if (pendingBySession.get(sessionId) === entry) {
        pendingBySession.delete(sessionId);
      }
    };

    if (input.signal?.aborted) {
      reject(new Error('已取消'));
      return;
    }
    input.signal?.addEventListener('abort', onAbort, { once: true });
    pendingBySession.set(sessionId, entry);
  });
}

/** 用戶在 Chat UI 回答；成功回 true */
export function answerChatUserQuestion(sessionId: string, answer: string): boolean {
  const pending = pendingBySession.get(sessionId);
  if (!pending) return false;
  const text = answer.trim();
  if (!text) return false;
  pending.resolve(text);
  return true;
}

export function cancelPendingChatQuestion(sessionId: string, reason = '已取消'): void {
  const pending = pendingBySession.get(sessionId);
  if (!pending) return;
  pending.reject(new Error(reason));
}

/** 僅清掉 pending，不 reject（用於回答成功後的保險清理） */
export function clearPendingChatQuestion(sessionId: string): void {
  pendingBySession.delete(sessionId);
}
