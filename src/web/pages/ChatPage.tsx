import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  chatApi,
  autoApi,
  ChatMessage,
  ChatMode,
  ChatSession,
  ChatStreamEvent,
} from '../lib/api';
import { Button, Badge, Textarea } from '../components/ui';

function isLiveStatus(status: ChatSession['status'] | undefined) {
  return status === 'streaming' || status === 'running';
}

function isAwaitingUser(status: ChatSession['status'] | undefined) {
  return status === 'awaiting_user';
}

function needsStream(status: ChatSession['status'] | undefined) {
  return isLiveStatus(status) || isAwaitingUser(status);
}

/** 是否處於「等用戶回答」：以 status 為準，並用 question 訊息/live 作兜底 */
function detectAwaitingUser(input: {
  status: ChatSession['status'] | undefined;
  messages: ChatMessage[];
  liveLines: ChatStreamEvent[];
}) {
  if (isAwaitingUser(input.status)) return true;
  if (input.liveLines.some((e) => e.kind === 'question')) return true;
  // 最後一則已落庫訊息是提問，且本輪尚未結束
  const last = input.messages[input.messages.length - 1];
  if (
    last?.kind === 'question' &&
    (input.status === 'running' || input.status === 'awaiting_user')
  ) {
    return true;
  }
  return false;
}

export function ChatPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveLines, setLiveLines] = useState<ChatStreamEvent[]>([]);
  const [mode, setMode] = useState<ChatMode>('ask');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [providerLabel, setProviderLabel] = useState('cursor');
  const chatListRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  /** 目前已連上 SSE 的 session；用來避免重連時重複訂閱 */
  const attachedStreamRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const active = sessions.find((s) => s.id === activeId) ?? null;

  const loadSessions = useCallback(async () => {
    if (!projectId) return;
    const list = await chatApi.listSessions(projectId);
    setSessions(list);
    return list;
  }, [projectId]);

  const loadMessages = useCallback(
    async (sessionId: string) => {
      if (!projectId) return;
      const msgs = await chatApi.listMessages(projectId, sessionId);
      setMessages(msgs);
    },
    [projectId],
  );

  const stopStream = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    attachedStreamRef.current = null;
  }, []);

  const startStream = useCallback(
    (sessionId: string) => {
      if (!projectId) return;
      // 同一 session 已在推流中則不重訂
      if (
        attachedStreamRef.current === sessionId &&
        streamAbortRef.current &&
        !streamAbortRef.current.signal.aborted
      ) {
        return;
      }

      stopStream();
      const controller = new AbortController();
      streamAbortRef.current = controller;
      attachedStreamRef.current = sessionId;
      setError('');
      setLiveLines([]);

      void chatApi.stream(
        projectId,
        sessionId,
        {
          onInit: (data) => {
            if (controller.signal.aborted) return;
            const lastUserAt = [...messagesRef.current]
              .reverse()
              .find((m) => m.role === 'user')?.at;
            setLiveLines(
              data.entries.filter((e) => {
                if (e.kind === 'status') return false;
                // 不要回放上一輪已落庫的 live 內容，否則新用戶訊息會插在舊回覆上面
                if (lastUserAt && e.at < lastUserAt) return false;
                return true;
              }),
            );
            setSessions((prev) =>
              prev.map((s) => (s.id === data.session.id ? data.session : s)),
            );
            if (isAwaitingUser(data.session.status)) {
              setBusy(false);
            } else if (isLiveStatus(data.session.status)) {
              setBusy(true);
            } else {
              setBusy(false);
            }
          },
          onEvent: (entry) => {
            if (controller.signal.aborted) return;
            if (entry.kind === 'status') {
              const nextStatus = entry.text as ChatSession['status'];
              setSessions((prev) =>
                prev.map((s) => (s.id === sessionId ? { ...s, status: nextStatus } : s)),
              );
              if (nextStatus === 'awaiting_user' || nextStatus === 'idle' || nextStatus === 'error') {
                setBusy(false);
              } else if (nextStatus === 'running' || nextStatus === 'streaming') {
                setBusy(true);
              }
              return;
            }
            if (entry.kind === 'question') {
              // 提問事件一到就解鎖輸入（不依賴 status 是否已更新）
              setBusy(false);
              setSessions((prev) =>
                prev.map((s) =>
                  s.id === sessionId && s.status === 'running'
                    ? { ...s, status: 'awaiting_user' }
                    : s,
                ),
              );
            }
            setLiveLines((prev) => {
              const last = prev[prev.length - 1];
              if (
                last &&
                (entry.kind === 'assistant' || entry.kind === 'thinking') &&
                last.kind === entry.kind &&
                last.messageId === entry.messageId
              ) {
                return [...prev.slice(0, -1), entry];
              }
              return [...prev, entry];
            });
          },
          onDone: async (data) => {
            if (attachedStreamRef.current === sessionId) {
              attachedStreamRef.current = null;
            }
            setSessions((prev) =>
              prev.map((s) => (s.id === data.session.id ? data.session : s)),
            );
            setLiveLines([]);
            await loadMessages(sessionId);
            await loadSessions();
            setBusy(false);
          },
          onError: (err) => {
            if (controller.signal.aborted) return;
            if (attachedStreamRef.current === sessionId) {
              attachedStreamRef.current = null;
            }
            setError(err.message);
            setBusy(false);
          },
        },
        { signal: controller.signal, sinceSeq: 0 },
      );
    },
    [projectId, stopStream, loadMessages, loadSessions],
  );

  // 進入頁面 / 切回進行中的對話：自動重連 SSE（含 buffer 回放）
  useEffect(() => {
    if (!projectId || !activeId) return;
    if (needsStream(active?.status)) {
      startStream(activeId);
    }
  }, [projectId, activeId, active?.status, startStream]);

  useEffect(() => {
    if (!projectId) return;
    void loadSessions()
      .then(async (list) => {
        if (!list?.length) {
          const created = await chatApi.createSession(projectId, { mode: 'ask' });
          setSessions([created]);
          setActiveId(created.id);
          setMode(created.mode);
          setMessages([]);
          setBusy(false);
          return;
        }
        const first = list[0];
        setActiveId(first.id);
        setMode(first.mode);
        setBusy(isLiveStatus(first.status) || isAwaitingUser(first.status));
        await loadMessages(first.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : '載入失敗'));

    void autoApi
      .runnerStatus(projectId)
      .then((r) => setProviderLabel(r.provider))
      .catch(() => undefined);
  }, [projectId, loadSessions, loadMessages]);

  useEffect(() => {
    const el = chatListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, liveLines]);

  // 離開 Chat 頁時斷開 SSE（後端任務繼續跑）
  useEffect(() => () => stopStream(), [stopStream]);

  const selectSession = async (id: string) => {
    if (!projectId) return;
    stopStream();
    setLiveLines([]);
    setActiveId(id);
    setError('');
    try {
      const fresh = await chatApi.getSession(projectId, id);
      setSessions((prev) => prev.map((s) => (s.id === fresh.id ? fresh : s)));
      setMode(fresh.mode);
      setBusy(isLiveStatus(fresh.status));
      await loadMessages(id);
      // running/streaming/awaiting_user 時由上面的 effect 自動 startStream
      if (isAwaitingUser(fresh.status)) setBusy(false);
    } catch (e) {
      const s = sessions.find((x) => x.id === id);
      if (s) setMode(s.mode);
      setBusy(false);
      setError(e instanceof Error ? e.message : '載入對話失敗');
      await loadMessages(id);
    }
  };

  const createSession = async () => {
    if (!projectId) return;
    stopStream();
    setBusy(true);
    setError('');
    try {
      const created = await chatApi.createSession(projectId, { mode });
      setSessions((prev) => [created, ...prev]);
      setActiveId(created.id);
      setMessages([]);
      setLiveLines([]);
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '建立對話失敗');
      setBusy(false);
    }
  };

  const removeSession = async (id: string) => {
    if (!projectId) return;
    if (activeId === id) stopStream();
    await chatApi.deleteSession(projectId, id);
    const list = await loadSessions();
    if (activeId === id) {
      const next = list?.[0];
      if (next) {
        setActiveId(next.id);
        setMode(next.mode);
        setBusy(isLiveStatus(next.status));
        if (isAwaitingUser(next.status)) setBusy(false);
        await loadMessages(next.id);
      } else {
        const created = await chatApi.createSession(projectId, { mode: 'ask' });
        setSessions([created]);
        setActiveId(created.id);
        setMode('ask');
        setBusy(false);
        setMessages([]);
      }
      setLiveLines([]);
    }
  };

  const switchMode = async (next: ChatMode) => {
    setMode(next);
    if (!projectId || !activeId) return;
    try {
      const updated = await chatApi.setMode(projectId, activeId, next);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch {
      /* ignore */
    }
  };

  const send = async () => {
    if (!projectId || !activeId || !input.trim()) return;
    const currentlyAwaiting = detectAwaitingUser({
      status: active?.status,
      messages,
      liveLines,
    });
    if (busy && !currentlyAwaiting) return;
    setBusy(true);
    setError('');
    const text = input.trim();
    setInput('');
    try {
      const result = await chatApi.sendMessage(projectId, activeId, { message: text, mode });
      messagesRef.current = result.messages;
      setMessages(result.messages);
      setSessions((prev) => {
        const others = prev.filter((s) => s.id !== result.session.id);
        return [result.session, ...others];
      });
      if (needsStream(result.session.status)) {
        startStream(activeId);
      } else {
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '傳送失敗');
      setBusy(false);
    }
  };

  const awaiting = detectAwaitingUser({
    status: active?.status,
    messages,
    liveLines,
  });
  // 等回答時必須可輸入；其餘 running/streaming/busy 才鎖定
  const inputLocked = !activeId || (!awaiting && (busy || isLiveStatus(active?.status)));
  const sessionBusy = inputLocked || awaiting;

  return (
    <div className="flex flex-col gap-3 -m-6 p-6" style={{ height: 'calc(100vh - 3rem)' }}>
      <div className="flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div>
          <h1 className="text-lg font-semibold">Agent Chat</h1>
          <p className="text-xs text-muted-foreground">
            Ask = 只讀問答（GLM）；Agent = 直接用專案 Runner（{providerLabel}）改檔 / 執行
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={mode === 'ask' ? 'default' : 'ghost'}
            disabled={sessionBusy}
            onClick={() => switchMode('ask')}
          >
            Ask
          </Button>
          <Button
            size="sm"
            variant={mode === 'agent' ? 'default' : 'ghost'}
            disabled={sessionBusy}
            onClick={() => switchMode('agent')}
          >
            Agent
          </Button>
          <Button size="sm" variant="outline" disabled={sessionBusy} onClick={createSession}>
            新對話
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2 shrink-0">
          {error}
        </p>
      )}

      <div className="flex flex-1 min-h-0 gap-3">
        <aside className="w-52 shrink-0 border border-border rounded-lg p-2 flex flex-col gap-1 overflow-auto">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => void selectSession(s.id)}
              className={`text-left px-2 py-2 rounded-md text-sm transition-colors ${
                s.id === activeId ? 'bg-accent font-medium' : 'hover:bg-accent/50'
              }`}
            >
              <div className="truncate">{s.title}</div>
              <div className="flex items-center gap-1 mt-0.5">
                <Badge className="text-[10px] px-1.5 py-0">{s.mode}</Badge>
                {s.status !== 'idle' && (
                  <Badge className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-800">
                    {s.status}
                  </Badge>
                )}
              </div>
            </button>
          ))}
          {activeId && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-auto text-red-600"
              disabled={sessionBusy}
              onClick={() => void removeSession(activeId)}
            >
              刪除此對話
            </Button>
          )}
        </aside>

        <section className="flex-1 min-w-0 border border-border rounded-lg flex flex-col overflow-hidden">
          <div
            ref={chatListRef}
            className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3"
          >
            {messages.length === 0 && liveLines.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {mode === 'ask'
                  ? 'Ask 模式：詢問專案結構、代碼含義、實作建議（不會改檔）。'
                  : 'Agent 模式：會呼叫專案設定的 Runner 直接動手；適合小改動與排查。'}
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex w-full min-w-0 shrink-0 ${
                  m.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`text-sm whitespace-pre-wrap break-words rounded-md px-3 py-2 max-w-[90%] ${
                    m.role === 'user'
                      ? 'bg-zinc-900 text-zinc-50'
                      : m.kind === 'error'
                        ? 'bg-red-50 text-red-800 border border-red-200'
                        : m.kind === 'question'
                          ? 'bg-amber-50 text-amber-950 border border-amber-300'
                          : m.role === 'system'
                            ? 'bg-amber-50 text-amber-900 border border-amber-200'
                            : 'bg-zinc-100 text-zinc-900'
                  }`}
                >
                  <div className="text-[10px] uppercase opacity-60 mb-1">
                    {m.kind === 'question' ? 'agent · 提問' : m.role}
                    {m.kind !== 'text' && m.kind !== 'question' ? ` · ${m.kind}` : ''}
                  </div>
                  {m.content}
                </div>
              </div>
            ))}
            {liveLines.map((e) => (
              <div key={`${e.seq}-${e.kind}`} className="flex w-full min-w-0 shrink-0 justify-start">
                <div
                  className={`text-sm whitespace-pre-wrap break-words rounded-md px-3 py-2 max-w-[90%] border border-dashed ${
                    e.kind === 'error'
                      ? 'border-red-300 bg-red-50 text-red-800'
                      : e.kind === 'question'
                        ? 'border-amber-400 bg-amber-50 text-amber-950'
                        : e.kind === 'thinking'
                          ? 'border-violet-200 bg-violet-50 text-violet-900'
                          : e.kind === 'tool'
                            ? 'border-sky-200 bg-sky-50 text-sky-900'
                            : 'border-zinc-300 bg-white text-zinc-800'
                  }`}
                >
                  <div className="text-[10px] uppercase opacity-60 mb-1">
                    {e.kind === 'question' ? 'live · 提問' : `live · ${e.kind}`}
                  </div>
                  {e.text}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-border p-3 flex flex-col gap-2 shrink-0">
            {awaiting && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                Agent 正在等你回答上方問題；回覆後會繼續執行。
              </p>
            )}
            <Textarea
              rows={3}
              value={input}
              disabled={inputLocked}
              placeholder={
                awaiting
                  ? '回答 Agent 的問題…'
                  : mode === 'ask'
                    ? '問關於這個專案的問題…'
                    : '描述要 Agent 做的事（會實際改檔）…'
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Ctrl / ⌘ + Enter 傳送</span>
              <Button
                onClick={() => void send()}
                disabled={inputLocked || !input.trim()}
              >
                {awaiting ? '回覆並繼續' : inputLocked ? '回覆中…' : '傳送'}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
