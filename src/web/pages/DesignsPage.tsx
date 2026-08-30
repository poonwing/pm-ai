import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { designsApi, DesignItem, DesignRecord, StudioMessage } from '../lib/api';
import { Button, Input, Textarea, Badge } from '../components/ui';
import { CodePreview } from '../components/CodePreview';

export function DesignsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [designs, setDesigns] = useState<DesignItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [design, setDesign] = useState<DesignRecord | null>(null);
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [chat, setChat] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const previewShellRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    if (!projectId) return;
    const [list, msgs] = await Promise.all([
      designsApi.list(projectId),
      designsApi.messages(projectId),
    ]);
    setDesigns(list);
    setMessages(msgs);
    return list;
  }, [projectId]);

  const loadDesign = useCallback(
    async (id: string) => {
      if (!projectId) return;
      const d = await designsApi.get(projectId, id);
      setDesign(d);
      setActiveId(d.id);
    },
    [projectId],
  );

  useEffect(() => {
    loadList()
      .then((list) => {
        if (list && list.length > 0) {
          void loadDesign(list[0]!.id);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : '載入失敗'));
  }, [loadList, loadDesign]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!design?.html) {
      setPreviewUrl(null);
      return;
    }
    const blob = new Blob([design.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [design?.html]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === previewShellRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (view !== 'preview' && document.fullscreenElement === previewShellRef.current) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [view]);

  const toggleFullscreen = async () => {
    const shell = previewShellRef.current;
    if (!shell || !previewUrl) return;
    setError('');
    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen();
      } else {
        await shell.requestFullscreen();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '無法切換全螢幕');
    }
  };

  const create = async () => {
    if (!projectId || !newTitle.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await designsApi.create(projectId, newTitle.trim());
      setNewTitle('');
      await loadList();
      setDesign(created);
      setActiveId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '新建失敗');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!projectId || !activeId) return;
    if (!window.confirm('刪除此設計稿？')) return;
    setBusy(true);
    try {
      await designsApi.delete(projectId, activeId);
      setDesign(null);
      setActiveId(null);
      const list = await loadList();
      if (list && list[0]) await loadDesign(list[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '刪除失敗');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!projectId || !chat.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await designsApi.generate(projectId, {
        message: chat.trim(),
        design_id: activeId ?? undefined,
        title: !activeId ? chat.trim().slice(0, 24) : undefined,
      });
      setChat('');
      setMessages(result.messages);
      setDesigns(result.designs);
      setDesign(result.design);
      setActiveId(result.design.id);
      setView('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失敗');
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!projectId || !activeId) return;
    try {
      await designsApi.download(projectId, activeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '下載失敗');
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-3 -m-6 p-6" style={{ height: 'calc(100vh - 3rem)' }}>
      <div className="flex items-start justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-xl font-semibold">UI 設計</h1>
          <p className="text-sm text-muted-foreground mt-1">
            與 AI 對話產出原生 HTML/CSS 設計稿，可預覽並下載給開發對照。本機 Agent 也可直接讀寫這些檔。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={download} disabled={!activeId}>
            下載 HTML
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={!activeId || busy}>
            刪除
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 shrink-0">{error}</p>}

      <div className="flex gap-2 items-center flex-wrap shrink-0">
        {designs.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`px-3 py-1.5 rounded-md text-sm border ${
              d.id === activeId
                ? 'bg-accent font-medium border-border'
                : 'border-border text-muted-foreground hover:bg-accent/50'
            }`}
            onClick={() => loadDesign(d.id).catch((e) => setError(e instanceof Error ? e.message : '載入失敗'))}
          >
            {d.title}
          </button>
        ))}
        <div className="flex items-center gap-1 ml-auto">
          <Input
            className="h-8 w-36"
            placeholder="新頁面標題"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <Button size="sm" variant="outline" onClick={create} disabled={busy || !newTitle.trim()}>
            新建
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="border border-border rounded-lg flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-border">
            <h2 className="font-medium text-sm">對話</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 bg-zinc-50">
            {messages.length === 0 && (
              <p className="text-sm text-muted-foreground">
                描述頁面結構、狀態與風格。會產出自包含 HTML，便於開發複製對照。
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
            {activeId && <Badge className="self-start">{design?.title ?? '目前頁面'}</Badge>}
            <Textarea
              rows={3}
              value={chat}
              onChange={(e) => setChat(e.target.value)}
              placeholder={
                activeId ? '描述要改的版面、元件或狀態…' : '描述要設計的頁面，將自動新建一份稿'
              }
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
                {busy ? '生成中，可能需要一兩分鐘…' : '發送'}
              </Button>
            </div>
          </div>
        </section>

        <section className="border border-border rounded-lg flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <h2 className="font-medium text-sm">設計稿</h2>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={view === 'preview' ? undefined : 'ghost'}
                onClick={() => setView('preview')}
              >
                預覽
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void toggleFullscreen()}
                disabled={view !== 'preview' || !previewUrl}
                title={view !== 'preview' ? '請先切換到預覽' : undefined}
              >
                {isFullscreen ? '退出全螢幕' : '全螢幕'}
              </Button>
              <Button
                size="sm"
                variant={view === 'source' ? undefined : 'ghost'}
                onClick={() => setView('source')}
              >
                源碼
              </Button>
            </div>
          </div>
          {!design ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-6">
              新建一頁，或直接在左側描述需求讓 AI 產出第一份設計稿。
            </div>
          ) : view === 'preview' ? (
            previewUrl ? (
              <div ref={previewShellRef} className="design-preview-shell flex-1 flex flex-col min-h-0 bg-white">
                <iframe
                  title={design.title}
                  src={previewUrl}
                  sandbox="allow-scripts"
                  className="flex-1 w-full border-0"
                />
              </div>
            ) : (
              <div className="p-3 text-sm text-muted-foreground">無法預覽</div>
            )
          ) : (
            <div className="flex-1 overflow-auto">
              <CodePreview code={design.html} filePath={`${design.slug}.html`} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
