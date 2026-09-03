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
  const chatEndRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

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
          return;
        }
        const first = list[0];
        setActiveId(first.id);
        setMode(first.mode);
        await loadMessages(first.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : '載入失敗'));

    void autoApi
      .runnerStatus(projectId)
      .then((r) => setProviderLabel(r.provider))
      .catch(() => undefined);
  }, [projectId, loadSessions, loadMessages]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, liveLines]);

  const selectSession = async (id: string) => {
    if (!projectId) return;
    streamAbortRef.current?.abort();
    setLiveLines([]);
    setActiveId(id);
    const s = sessions.find((x) => x.id === id);
    if (s) setMode(s.mode);
    setBusy(false);
    await loadMessages(id);
  };

  const createSession = async () => {
    if (!projectId) return;
    setBusy(true);
    setError('');
    try {
      const created = await chatApi.createSession(projectId, { mode });
      setSessions((prev) => [created, ...prev]);
      setActiveId(created.id);
      setMessages([]);
      setLiveLines([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '建立對話失敗');
    } finally {
      setBusy(false);
    }
  };

  const removeSession = async (id: string) => {
    if (!projectId) return;
    await chatApi.deleteSession(projectId, id);
    const list = await loadSessions();
    if (activeId === id) {
      const next = list?.[0];
      if (next) {
        setActiveId(next.id);
        setMode(next.mode);
        await loadMessages(next.id);
      } else {
        const created = await chatApi.createSession(projectId, { mode: 'ask' });
        setSessions([created]);
        setActiveId(created.id);
        setMode('ask');
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

  const startStream = (sessionId: string) => {
    if (!projectId) return;
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setLiveLines([]);

    void chatApi.stream(
      projectId,
      sessionId,
      {
        onInit: (data) => {
          setLiveLines(data.entries.filter((e) => e.kind !== 'status'));
          setSessions((prev) => prev.map((s) => (s.id === data.session.id ? data.session : s)));
        },
        onEvent: (entry) => {
          if (entry.kind === 'status') return;
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
          setSessions((prev) => prev.map((s) => (s.id === data.session.id ? data.session : s)));
          setLiveLines([]);
          await loadMessages(sessionId);
          await loadSessions();
          setBusy(false);
        },
        onError: (err) => {
          setError(err.message);
          setBusy(false);
        },
      },
      { signal: controller.signal },
    );
  };

  const send = async () => {
    if (!projectId || !activeId || !input.trim() || busy) return;
    setBusy(true);
    setError('');
    const text = input.trim();
    setInput('');
    try {
      const result = await chatApi.sendMessage(projectId, activeId, { message: text, mode });
      setMessages(result.messages);
      setSessions((prev) => {
        const others = prev.filter((s) => s.id !== result.session.id);
        return [result.session, ...others];
      });
      startStream(activeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '傳送失敗');
      setBusy(false);
    }
  };

  const isLive =
    busy || active?.status === 'streaming' || active?.status === 'running';

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
            disabled={isLive}
            onClick={() => switchMode('ask')}
          >
            Ask
          </Button>
          <Button
            size="sm"
            variant={mode === 'agent' ? 'default' : 'ghost'}
            disabled={isLive}
            onClick={() => switchMode('agent')}
          >
            Agent
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={createSession}>
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
              disabled={isLive}
              onClick={() => void removeSession(activeId)}
            >
              刪除此對話
            </Button>
          )}
        </aside>

        <section className="flex-1 min-w-0 border border-border rounded-lg flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto p-4 flex flex-col gap-3">
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
                className={`text-sm whitespace-pre-wrap rounded-md px-3 py-2 max-w-[90%] ${
                  m.role === 'user'
                    ? 'bg-zinc-900 text-zinc-50 self-end'
                    : m.kind === 'error'
                      ? 'bg-red-50 text-red-800 border border-red-200 self-start'
                      : m.role === 'system'
                        ? 'bg-amber-50 text-amber-900 border border-amber-200 self-start'
                        : 'bg-zinc-100 text-zinc-900 self-start'
                }`}
              >
                <div className="text-[10px] uppercase opacity-60 mb-1">
                  {m.role}
                  {m.kind !== 'text' ? ` · ${m.kind}` : ''}
                </div>
                {m.content}
              </div>
            ))}
            {liveLines.map((e) => (
              <div
                key={`${e.seq}-${e.kind}`}
                className={`text-sm whitespace-pre-wrap rounded-md px-3 py-2 max-w-[90%] self-start border border-dashed ${
                  e.kind === 'error'
                    ? 'border-red-300 bg-red-50 text-red-800'
                    : e.kind === 'thinking'
                      ? 'border-violet-200 bg-violet-50 text-violet-900'
                      : e.kind === 'tool'
                        ? 'border-sky-200 bg-sky-50 text-sky-900'
                        : 'border-zinc-300 bg-white text-zinc-800'
                }`}
              >
                <div className="text-[10px] uppercase opacity-60 mb-1">live · {e.kind}</div>
                {e.text}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="border-t border-border p-3 flex flex-col gap-2 shrink-0">
            <Textarea
              rows={3}
              value={input}
              disabled={!activeId || isLive}
              placeholder={
                mode === 'ask'
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
              <Button onClick={() => void send()} disabled={!activeId || isLive || !input.trim()}>
                {isLive ? '回覆中…' : '傳送'}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
