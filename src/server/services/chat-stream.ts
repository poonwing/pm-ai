export type ChatStreamKind = 'system' | 'assistant' | 'tool' | 'thinking' | 'error' | 'status';

export interface ChatStreamEvent {
  seq: number;
  at: string;
  kind: ChatStreamKind;
  text: string;
  messageId?: string;
}

const MAX_ENTRIES = 400;
const buffers = new Map<string, ChatStreamEvent[]>();
const listeners = new Map<string, Set<(entry: ChatStreamEvent) => void>>();
let globalSeq = 0;

export function appendChatStream(
  sessionId: string,
  kind: ChatStreamKind,
  text: string,
  messageId?: string,
): ChatStreamEvent | null {
  const trimmed = text.trim();
  if (!trimmed && kind !== 'status') return null;

  const entry: ChatStreamEvent = {
    seq: ++globalSeq,
    at: new Date().toISOString(),
    kind,
    text: (text || '').slice(0, 12000),
    messageId,
  };

  let buf = buffers.get(sessionId);
  if (!buf) {
    buf = [];
    buffers.set(sessionId, buf);
  }
  buf.push(entry);
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);

  for (const fn of listeners.get(sessionId) ?? []) {
    try {
      fn(entry);
    } catch {
      /* ignore */
    }
  }
  return entry;
}

export function updateOrAppendChatStream(
  sessionId: string,
  kind: ChatStreamKind,
  text: string,
  messageId?: string,
): ChatStreamEvent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let buf = buffers.get(sessionId);
  if (!buf) {
    buf = [];
    buffers.set(sessionId, buf);
  }

  const last = buf[buf.length - 1];
  const mergeable = kind === 'assistant' || kind === 'thinking';
  if (mergeable && last && last.kind === kind && last.messageId === messageId) {
    last.text = trimmed.slice(0, 12000);
    last.at = new Date().toISOString();
    for (const fn of listeners.get(sessionId) ?? []) {
      try {
        fn({ ...last });
      } catch {
        /* ignore */
      }
    }
    return { ...last };
  }

  return appendChatStream(sessionId, kind, trimmed, messageId);
}

export function getChatStream(sessionId: string, sinceSeq = 0) {
  const buf = buffers.get(sessionId) ?? [];
  const entries = buf.filter((e) => e.seq > sinceSeq);
  const latestSeq = buf.length ? buf[buf.length - 1].seq : sinceSeq;
  return { entries, latestSeq };
}

export function subscribeChatStream(
  sessionId: string,
  fn: (entry: ChatStreamEvent) => void,
): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(sessionId);
  };
}

/** 清空本 session 的歷史事件，但保留現有 SSE 訂閱（新一輪對話用）。 */
export function resetChatStream(sessionId: string) {
  buffers.set(sessionId, []);
}

export function clearChatStream(sessionId: string) {
  buffers.delete(sessionId);
  listeners.delete(sessionId);
}
