import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { requirementsApi, StudioMessage } from '../lib/api';
import { Button, Textarea } from '../components/ui';
import { formatRelativeTime } from '../lib/utils';

export function RequirementsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [markdown, setMarkdown] = useState('');
  const [savedMarkdown, setSavedMarkdown] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  const [chat, setChat] = useState('');
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const dirty = markdown !== savedMarkdown;

  const load = useCallback(async () => {
    if (!projectId) return;
    const [doc, msgs] = await Promise.all([
      requirementsApi.get(projectId),
      requirementsApi.messages(projectId),
    ]);
    setMarkdown(doc.markdown);
    setSavedMarkdown(doc.markdown);
    setUpdatedAt(doc.updatedAt);
    setMessages(msgs);
  }, [projectId]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : '載入失敗'));
  }, [load]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const save = async () => {
    if (!projectId) return;
    setBusy(true);
    setError('');
    try {
      const doc = await requirementsApi.save(projectId, markdown);
      setSavedMarkdown(doc.markdown);
      setUpdatedAt(doc.updatedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : '儲存失敗');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!projectId || !chat.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await requirementsApi.analyze(projectId, {
        message: chat.trim(),
      });
      setChat('');
      setMessages(result.messages);
      setMarkdown(result.markdown);
      setSavedMarkdown(result.markdown);
      setUpdatedAt(result.updatedAt);
      setMode('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : '分析失敗');
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!projectId) return;
    try {
      await requirementsApi.download(projectId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '下載失敗');
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-3 -m-6 p-6" style={{ height: 'calc(100vh - 3rem)' }}>
      <div className="flex items-start justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-xl font-semibold">需求分析</h1>
          <p className="text-sm text-muted-foreground mt-1">
            直接描述需求即可；AI 會自動判斷是新項目規劃，還是對照現有代碼整理。文档為一份 Markdown，可下載。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {updatedAt && (
            <span className="text-xs text-muted-foreground">
              更新於 {formatRelativeTime(updatedAt)}
            </span>
          )}
          <Button size="sm" variant="outline" onClick={download}>
            下載 MD
          </Button>
          <Button size="sm" onClick={save} disabled={busy || !dirty}>
            {dirty ? '儲存' : '已儲存'}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 shrink-0">{error}</p>}

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="border border-border rounded-lg flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-border">
            <h2 className="font-medium text-sm">對話</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 bg-zinc-50">
            {messages.length === 0 && (
              <p className="text-sm text-muted-foreground">
                例如：「做一個待辦 App」或「根據現有代碼整理需求文档」。若需嚴格只讀代碼，可寫「請根據現有代碼整理，不要假設」。
              </p>
            )}
            {messages.map((m) => (
              <div key={m.id} className="text-sm">
                <span className="text-xs text-muted-foreground uppercase mr-2">{m.role}</span>
                <span className="whitespace-pre-wrap">{m.content}</span>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div className="p-3 border-t border-border flex flex-col gap-2">
            <Textarea
              rows={3}
              value={chat}
              onChange={(e) => setChat(e.target.value)}
              placeholder="描述目標、功能、不做什麼；或請 AI 整理現有專案…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted-foreground">Ctrl/⌘ + Enter 發送</span>
              <Button onClick={send} disabled={busy || !chat.trim()}>
                {busy ? '處理中…' : '發送'}
              </Button>
            </div>
          </div>
        </section>

        <section className="border border-border rounded-lg flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <h2 className="font-medium text-sm">需求文档</h2>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={mode === 'preview' ? undefined : 'ghost'}
                onClick={() => setMode('preview')}
              >
                預覽
              </Button>
              <Button
                size="sm"
                variant={mode === 'edit' ? undefined : 'ghost'}
                onClick={() => setMode('edit')}
              >
                編輯
              </Button>
            </div>
          </div>
          {mode === 'edit' ? (
            <textarea
              className="flex-1 min-h-0 w-full p-3 text-sm font-mono resize-none bg-background focus:outline-none"
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
            />
          ) : (
            <div className="flex-1 overflow-y-auto p-4 markdown-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown || '_（空文档）_'}</ReactMarkdown>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
