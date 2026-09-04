import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  autoApi,
  projectsApi,
  AutoRun,
  AutoRunMessage,
  AutoRunDebugSnapshot,
  AutoRunEvent,
  Decision,
  ReviewPolicy,
} from '../lib/api';
import { Button, Input, Textarea, Label, Badge } from '../components/ui';
import { AutoWorkflowDiagram } from '../components/AutoWorkflowDiagram';

const EVENT_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'graph', label: 'Graph' },
  { id: 'runner', label: 'Runner' },
  { id: 'ai_review', label: 'AI 復查' },
  { id: 'decision', label: '決策' },
  { id: 'system', label: '系統' },
] as const;

/** 對話列表：載入與更新後都貼齊最新訊息 */
function AutoChatThread({
  messages,
  className,
}: {
  messages: AutoRunMessage[];
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  const scrollToLatest = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    scrollToLatest();
  }, [messages, scrollToLatest]);

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const ro = new ResizeObserver(() => scrollToLatest());
    ro.observe(inner);
    scrollToLatest();
    const t = window.setTimeout(scrollToLatest, 50);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [messages, scrollToLatest]);

  return (
    <div
      ref={listRef}
      className={`min-h-0 overflow-y-auto border border-border rounded-md p-3 bg-zinc-50 ${className ?? ''}`}
    >
      <div ref={innerRef} className="flex flex-col gap-2">
        {messages.map((m) => (
          <div key={m.id} className="text-sm">
            <span className="text-xs text-muted-foreground uppercase mr-2">{m.role}</span>
            <span className="whitespace-pre-wrap">{m.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function eventCategoryClass(category: string): string {
  switch (category) {
    case 'runner':
      return 'bg-sky-100 text-sky-900';
    case 'ai_review':
      return 'bg-violet-100 text-violet-900';
    case 'decision':
      return 'bg-amber-100 text-amber-900';
    case 'graph':
      return 'bg-emerald-100 text-emerald-900';
    default:
      return 'bg-zinc-100 text-zinc-800';
  }
}

function EventTimeline({ events }: { events: AutoRunEvent[] }) {
  const [filter, setFilter] = useState<(typeof EVENT_FILTERS)[number]['id']>('all');
  const filtered =
    filter === 'all' ? events : events.filter((e) => e.category === filter);
  const recent = filtered.slice(-60);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
        <div className="text-xs text-muted-foreground">事件時間線</div>
        <div className="flex flex-wrap gap-1">
          {EVENT_FILTERS.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={filter === f.id ? 'default' : 'ghost'}
              className="h-6 px-2 text-[11px]"
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>
      {recent.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          尚無結構化事件（重啟服務後新產生的 Run 活動才會寫入）。
        </p>
      ) : (
        <ul className="max-h-56 overflow-y-auto flex flex-col gap-1 border border-border rounded-md bg-white p-2">
          {recent.map((e) => (
            <li
              key={e.id}
              className="text-xs flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/40 pb-1 last:border-0"
            >
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                {new Date(e.at).toLocaleTimeString()}
              </span>
              <Badge className={`text-[10px] px-1.5 py-0 ${eventCategoryClass(e.category)}`}>
                {e.category}
              </Badge>
              <span className="font-mono text-[10px] text-muted-foreground">{e.type}</span>
              <span className="min-w-0 break-words">{e.summary}</span>
              {e.task_id && (
                <code className="text-[10px] text-muted-foreground">{e.task_id}</code>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function blockedBadgeClass(reason: string): string {
  if (reason === 'none' || reason === 'completed') return 'bg-emerald-100 text-emerald-800';
  if (reason === 'stopped' || reason === 'no_model') return 'bg-red-100 text-red-800';
  if (
    reason === 'wait_ai_review' ||
    reason === 'ai_review_cooldown' ||
    reason === 'awaiting_human' ||
    reason === 'awaiting_decision'
  ) {
    return 'bg-amber-100 text-amber-900';
  }
  return 'bg-zinc-100 text-zinc-800';
}

function RunInspector({
  debug,
  loading,
  onRefresh,
  projectId,
}: {
  debug: AutoRunDebugSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
  projectId: string;
}) {
  const [open, setOpen] = useState(true);
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    if (!debug) return;
    if (debug.blockedReason !== 'none' && debug.blockedReason !== 'completed') {
      setOpen(true);
    }
  }, [debug?.blockedReason, debug?.runId]);

  if (!debug && !loading) return null;

  const m = debug?.taskMatrix;
  const graphNext = debug?.graph.next?.length ? debug.graph.next.join(', ') : '—';

  return (
    <section className="border border-border rounded-lg p-4 flex flex-col gap-3 bg-zinc-50/80">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="font-medium text-sm">Run Inspector</h2>
          {debug && (
            <Badge className={blockedBadgeClass(debug.blockedReason)}>{debug.blockedReason}</Badge>
          )}
          {loading && <span className="text-xs text-muted-foreground">更新中…</span>}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading}>
            重新整理
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? '收合' : '展開'}
          </Button>
        </div>
      </div>

      {debug && (
        <p className="text-sm text-amber-900/90 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          {debug.blockedHint}
        </p>
      )}

      {debug?.aiReviewActivity && debug.aiReviewActivity.pendingCount > 0 && (
        <div
          className={
            debug.aiReviewActivity.status === 'in_flight'
              ? 'text-sm border border-violet-300 bg-violet-50 text-violet-950 rounded-md px-3 py-2'
              : debug.aiReviewActivity.status === 'no_model'
                ? 'text-sm border border-red-300 bg-red-50 text-red-900 rounded-md px-3 py-2'
                : 'text-sm border border-amber-300 bg-amber-50 text-amber-950 rounded-md px-3 py-2'
          }
        >
          <div className="font-medium text-xs uppercase tracking-wide mb-1">
            AI 復查狀態 ·{' '}
            {debug.aiReviewActivity.status === 'in_flight'
              ? '復查中'
              : debug.aiReviewActivity.status === 'cooldown'
                ? '冷卻中（未在執行）'
                : debug.aiReviewActivity.status === 'no_model'
                  ? '無法執行'
                  : '未在執行（待派發）'}
          </div>
          <p>{debug.aiReviewActivity.summary}</p>
          <p className="text-xs mt-1 opacity-80">
            in-flight {debug.aiReviewActivity.inFlightCount} · ready{' '}
            {debug.aiReviewActivity.readyCount} · cooldown{' '}
            {debug.aiReviewActivity.cooldownCount}
          </p>
        </div>
      )}

      {open && debug && (
        <div className="flex flex-col gap-3 text-sm">
          <AutoWorkflowDiagram debug={debug} />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="border border-border rounded-md p-2 bg-white">
              <div className="text-muted-foreground">Run</div>
              <div className="font-mono truncate">{debug.status} / {debug.phase}</div>
            </div>
            <div className="border border-border rounded-md p-2 bg-white">
              <div className="text-muted-foreground">Graph next</div>
              <div className="font-mono truncate">{graphNext}</div>
            </div>
            <div className="border border-border rounded-md p-2 bg-white">
              <div className="text-muted-foreground">Interrupt</div>
              <div className="font-mono">
                {debug.graph.pendingInterrupt ? 'yes' : 'no'}
                {!debug.graph.hasGraphState ? ' · no state' : ''}
              </div>
            </div>
            <div className="border border-border rounded-md p-2 bg-white">
              <div className="text-muted-foreground">ZAI model</div>
              <div className="font-mono">{debug.modelConfigured ? 'ok' : 'missing key'}</div>
            </div>
          </div>

          {m && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">任務矩陣</div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge>total {m.total}</Badge>
                <Badge>todo {m.todo}</Badge>
                <Badge>in_progress {m.in_progress}</Badge>
                <Badge>done {m.done}</Badge>
                <Badge className="bg-amber-100 text-amber-900">
                  待 AI 復查 {m.pending_ai_review}
                </Badge>
                <Badge className="bg-sky-100 text-sky-900">
                  待人驗收 {m.pending_human_review}
                </Badge>
              </div>
            </div>
          )}

          {debug.aiReviews.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">AI 復查佇列</div>
              <ul className="flex flex-col gap-1.5">
                {debug.aiReviews.map((r) => (
                  <li
                    key={r.taskId}
                    className="flex flex-wrap items-center gap-2 text-xs border-b border-border/50 pb-1"
                  >
                    <Link
                      className="underline font-mono"
                      to={`/projects/${projectId}/tasks/${r.taskId}`}
                    >
                      {r.taskId}
                    </Link>
                    <span className="truncate max-w-[12rem]">{r.title}</span>
                    <Badge>{r.reviewerType}/{r.reviewStatus}</Badge>
                    {r.inFlight ? (
                      <Badge className="bg-violet-100 text-violet-900">復查中</Badge>
                    ) : r.cooldownRemainingMs > 0 ? (
                      <Badge className="bg-amber-100">
                        冷卻 {Math.ceil(r.cooldownRemainingMs / 1000)}s
                      </Badge>
                    ) : (
                      <Badge className="bg-zinc-200">未派發</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="text-xs text-muted-foreground mb-1">
              Runner（active {debug.runner.activeCount} · {debug.runner.provider}/
              {debug.runner.source}
              {!debug.runner.ready ? ' · not ready' : ''}）
            </div>
            {debug.runner.jobs.length === 0 ? (
              <p className="text-xs text-muted-foreground">本 Run 無關聯 job</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {debug.runner.jobs.slice(0, 8).map((j) => (
                  <li key={j.id} className="text-xs flex flex-wrap gap-2 items-center">
                    <code>{j.taskId}</code>
                    <Badge>{j.status}</Badge>
                    {j.error && <span className="text-red-600 truncate max-w-sm">{j.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {debug.openDecisions.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">未關閉決策</div>
              <ul className="text-xs list-disc pl-4">
                {debug.openDecisions.map((d) => (
                  <li key={d.id}>{d.title}</li>
                ))}
              </ul>
            </div>
          )}

          <EventTimeline events={debug.events ?? []} />

          <div>
            <div className="text-xs text-muted-foreground mb-1">Checkpoint 摘要</div>
            <div className="text-xs font-mono bg-white border border-border rounded-md p-2 space-y-0.5">
              <div>research_done: {String(debug.checkpoint.research_done)}</div>
              <div>clarified: {String(debug.checkpoint.clarified)}</div>
              <div>plan_tasks: {debug.checkpoint.plan_task_count ?? '—'}</div>
              <div>
                created_task_ids: {debug.checkpoint.created_task_ids.join(', ') || '—'}
              </div>
              {debug.checkpoint.research_task_id && (
                <div>research_task_id: {debug.checkpoint.research_task_id}</div>
              )}
            </div>
          </div>

          {debug.tasks.filter((t) => t.pendingReview || t.status !== 'done').length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">任務明細（非全完成 / 待審）</div>
              <ul className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                {debug.tasks
                  .filter((t) => t.pendingReview || t.status !== 'done')
                  .map((t) => (
                    <li key={t.id} className="text-xs flex flex-wrap gap-2 items-center">
                      <Link
                        className="underline font-mono"
                        to={`/projects/${projectId}/tasks/${t.id}`}
                      >
                        {t.id}
                      </Link>
                      <Badge>{t.status}</Badge>
                      {t.pendingReview && (
                        <Badge className="bg-amber-100">
                          {t.reviewerType}/{t.reviewStatus}
                        </Badge>
                      )}
                      <span className="truncate text-muted-foreground">{t.title}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowJson((v) => !v)}>
              {showJson ? '隱藏 raw JSON' : '顯示 raw JSON'}
            </Button>
            <span className="text-[10px] text-muted-foreground">
              {new Date(debug.generatedAt).toLocaleTimeString()}
            </span>
          </div>
          {showJson && (
            <pre className="text-[10px] max-h-64 overflow-auto bg-white border border-border rounded-md p-2">
              {JSON.stringify(debug, null, 2)}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

export function AutoPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [runs, setRuns] = useState<AutoRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AutoRunMessage[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [policy, setPolicy] = useState<ReviewPolicy | null>(null);
  const [runnerJobs, setRunnerJobs] = useState<
    Array<{
      id: string;
      taskId: string;
      status: string;
      agentName: string;
      provider?: string;
      error?: string | null;
      resultSummary?: string | null;
      updatedAt: string;
      kind?: string;
    }>
  >([]);
  const [runnerConfigured, setRunnerConfigured] = useState(false);
  const [runnerHint, setRunnerHint] = useState<string | null>(null);
  const [runnerProvider, setRunnerProvider] = useState<'cursor' | 'pi'>('cursor');
  const [runnerProviderSource, setRunnerProviderSource] = useState<'project' | 'env'>('env');
  const [runnerDefaultProvider, setRunnerDefaultProvider] = useState<'cursor' | 'pi'>('cursor');
  const [goal, setGoal] = useState('');
  const [chat, setChat] = useState('');
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [debug, setDebug] = useState<AutoRunDebugSnapshot | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);

  const loadDebug = useCallback(async (runId: string) => {
    setDebugLoading(true);
    try {
      const snap = await autoApi.getRunDebug(runId);
      setDebug(snap);
    } catch {
      /* keep previous snapshot */
    } finally {
      setDebugLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    if (!projectId) return;
    const [r, pol, openDec, runner] = await Promise.all([
      autoApi.listRuns(projectId),
      autoApi.getPolicy(projectId),
      autoApi.listDecisions(projectId, 'open'),
      autoApi.runnerStatus(projectId).catch(() => null),
    ]);
    setRuns(r);
    setPolicy(pol);
    setDecisions(openDec);
    if (runner) {
      setRunnerConfigured(runner.configured);
      setRunnerHint(runner.hint);
      setRunnerProvider(runner.provider);
      setRunnerProviderSource(runner.source ?? 'env');
      setRunnerDefaultProvider(runner.defaultProvider ?? runner.provider);
      setRunnerJobs(runner.jobs);
    }
    const live =
      r.find((x) => ['running', 'awaiting_human', 'paused'].includes(x.status)) ?? null;
    const active = live ?? r[0] ?? null;
    if (active) {
      setActiveRunId(active.id);
      const detail = await autoApi.getRun(active.id);
      setMessages(detail.messages);
      setDecisions(detail.decisions?.length ? detail.decisions : openDec);
      void loadDebug(active.id);
      if (!live) {
        setGoal((g) => g.trim() || active.goal || '');
      }
    } else {
      setActiveRunId(null);
      setMessages([]);
      setDebug(null);
    }
  }, [projectId, loadDebug]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : '載入失敗'));
  }, [load]);

  useEffect(() => {
    if (!projectId) return;
    const hasActive = runnerJobs.some((j) =>
      ['queued', 'claiming', 'running'].includes(j.status),
    );
    if (!hasActive && !activeRunId) return;
    const t = setInterval(() => {
      autoApi
        .runnerStatus(projectId)
        .then((runner) => {
          setRunnerConfigured(runner.configured);
          setRunnerHint(runner.hint);
          setRunnerProvider(runner.provider);
          setRunnerProviderSource(runner.source ?? 'env');
          setRunnerDefaultProvider(runner.defaultProvider ?? runner.provider);
          setRunnerJobs(runner.jobs);
        })
        .catch(() => undefined);
      if (activeRunId) {
        autoApi
          .getRun(activeRunId)
          .then((detail) => {
            setMessages(detail.messages);
          })
          .catch(() => undefined);
        void loadDebug(activeRunId);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [projectId, activeRunId, runnerJobs, loadDebug]);

  const refreshRun = async (runId: string) => {
    const detail = await autoApi.getRun(runId);
    setMessages(detail.messages);
    setDecisions(detail.decisions);
    setRuns(await autoApi.listRuns(projectId!));
    await loadDebug(runId);
  };

  const start = async () => {
    if (!projectId || !goal.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await autoApi.startRun(projectId, goal.trim());
      setActiveRunId(result.run.id);
      setMessages(result.messages);
      setDecisions(result.decisions ?? []);
      setGoal('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '啟動失敗');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!activeRunId || !chat.trim()) return;
    setBusy(true);
    try {
      const result = await autoApi.message(activeRunId, chat.trim());
      setMessages(result.messages);
      setDecisions(result.decisions ?? []);
      setChat('');
      await refreshRun(activeRunId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '發送失敗');
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (d: Decision, optionId: string) => {
    const note = decisionNotes[d.id]?.trim() ?? '';
    if (optionId === 'custom' && !note) {
      setError('自訂決策請先填寫說明');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await autoApi.resolveDecision(d.id, optionId, note || undefined);
      if (result.messages) setMessages(result.messages);
      if (result.run) setActiveRunId(result.run.id);
      setDecisionNotes((prev) => {
        const next = { ...prev };
        delete next[d.id];
        return next;
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '決策失敗');
    } finally {
      setBusy(false);
    }
  };

  const setRunnerProviderForProject = async (provider: 'cursor' | 'pi') => {
    if (!projectId || busy) return;
    setBusy(true);
    setError('');
    try {
      await projectsApi.update(projectId, { runner_provider: provider });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '切換 Runner Provider 失敗');
    } finally {
      setBusy(false);
    }
  };

  const REVIEWER_OPTIONS = [
    { value: 'human', label: 'human（人類）' },
    { value: 'agent', label: 'agent（AI 員工）' },
    { value: 'orchestrator', label: 'orchestrator' },
    { value: 'none', label: 'none（不審查）' },
  ] as const;

  const savePolicy = async (confirm: boolean) => {
    if (!projectId || !policy) return;
    setBusy(true);
    setError('');
    try {
      await autoApi.updatePolicy(
        projectId,
        { default_reviewer_type: policy.default_reviewer_type },
        confirm,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新 Review Policy 失敗');
    } finally {
      setBusy(false);
    }
  };

  const activeRun = runs.find((r) => r.id === activeRunId);
  const runLive = Boolean(
    activeRun && ['running', 'awaiting_human', 'paused'].includes(activeRun.status),
  );
  const runEnded = Boolean(
    activeRun && ['stopped', 'completed'].includes(activeRun.status),
  );

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label}失敗`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold">Auto 工作台</h1>
        <p className="text-sm text-muted-foreground mt-1">
          與協調者先對齊需求，確認後進入設計與分派。模糊目標請多聊幾輪，回覆「開始工作」才開工。
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {activeRunId && projectId && (
        <RunInspector
          debug={debug}
          loading={debugLoading}
          projectId={projectId}
          onRefresh={() => void loadDebug(activeRunId)}
        />
      )}

      <section className="border border-border rounded-lg p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">預設審查偏好</h2>
          <Badge className="bg-zinc-100 text-zinc-700">設定 · 非流程門檻</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          僅作為協調者規劃任務時的預設提示；每個任務的實際審查者仍由協調者決定。不會再阻擋 Auto Run 流程。
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1 min-w-[12rem]">
            <Label htmlFor="default-reviewer-type">預設審查</Label>
            <select
              id="default-reviewer-type"
              className="text-sm border border-border rounded-md px-2 py-1.5 bg-background"
              value={policy?.default_reviewer_type ?? 'human'}
              disabled={!policy || busy}
              onChange={(e) =>
                setPolicy((prev) =>
                  prev ? { ...prev, default_reviewer_type: e.target.value } : prev,
                )
              }
            >
              {REVIEWER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <Button size="sm" disabled={busy || !policy} onClick={() => savePolicy(true)}>
            儲存
          </Button>
        </div>
      </section>

      {decisions.filter((d) => d.status === 'open').length > 0 && (
        <section className="border border-amber-300 bg-amber-50/50 rounded-lg p-4 flex flex-col gap-3">
          <h2 className="font-medium text-sm">待你決策</h2>
          {decisions
            .filter((d) => d.status === 'open')
            .map((d) => (
              <div key={d.id} className="flex flex-col gap-2">
                <div className="font-medium text-sm">{d.title}</div>
                <p className="text-sm text-muted-foreground">{d.summary}</p>
                <div className="flex flex-wrap gap-2">
                  {d.options
                    .filter((o) => o.id !== 'custom')
                    .map((o) => (
                      <Button
                        key={o.id}
                        size="sm"
                        disabled={busy}
                        onClick={() => resolve(d, o.id)}
                      >
                        {o.label}
                        {d.recommended_option_id === o.id ? '（推薦）' : ''}
                      </Button>
                    ))}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`decision-note-${d.id}`}>說明 / 自訂決策</Label>
                  <Textarea
                    id={`decision-note-${d.id}`}
                    rows={3}
                    value={decisionNotes[d.id] ?? ''}
                    disabled={busy}
                    placeholder="選預設選項時可選填備註；或在此寫下自訂決定後點「提交自訂決策」"
                    onChange={(e) =>
                      setDecisionNotes((prev) => ({ ...prev, [d.id]: e.target.value }))
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !(decisionNotes[d.id]?.trim())}
                    onClick={() => resolve(d, 'custom')}
                  >
                    提交自訂決策
                  </Button>
                </div>
              </div>
            ))}
        </section>
      )}

      <section className="border border-border rounded-lg p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-medium text-sm">任务执行器（Runner）</h2>
          <div className="flex items-center gap-2">
            <Badge>{runnerProvider}</Badge>
            <Badge className="bg-zinc-100 text-zinc-700">
              {runnerProviderSource === 'project' ? '本專案設定' : `沿用 .env（${runnerDefaultProvider}）`}
            </Badge>
            <Badge className={runnerConfigured ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100'}>
              {runnerConfigured
                ? runnerProvider === 'pi'
                  ? 'GLM Key 可用'
                  : 'Cursor Key 可用'
                : runnerProvider === 'pi'
                  ? '缺少 ZAI_API_KEY'
                  : '缺少 CURSOR_API_KEY'}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Provider：</span>
          <Button
            size="sm"
            variant={runnerProvider === 'pi' ? 'default' : 'ghost'}
            disabled={busy}
            onClick={() => setRunnerProviderForProject('pi')}
          >
            Pi Agent（GLM）
          </Button>
          <Button
            size="sm"
            variant={runnerProvider === 'cursor' ? 'default' : 'ghost'}
            disabled={busy}
            onClick={() => setRunnerProviderForProject('cursor')}
          >
            Cursor SDK
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          每個專案可獨立選擇 Runner。設定寫入{' '}
          <code>.pm-ai/project.yml</code> 的 <code>runner_provider</code>
          ；未設定時沿用全域 <code>.env</code> 的 <code>RUNNER_PROVIDER</code>
          。Pi Agent 复用 <code>ZAI_API_KEY</code>，進程內執行，無需安裝 OpenCode CLI。
        </p>
        {runnerProvider === 'pi' && !runnerConfigured && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            {runnerHint ?? '未配置 ZAI_API_KEY，無法啟動 Pi Agent Runner。'}
          </p>
        )}
        {runnerJobs.filter((j) => j.kind !== 'studio').length === 0 ? (
          <p className="text-xs text-muted-foreground">尚無執行任務。分派後會自動排隊。</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {runnerJobs
              .filter((j) => j.kind !== 'studio')
              .slice(0, 12)
              .map((j) => (
              <li key={j.id} className="flex flex-col gap-0.5 border-b border-border/60 pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-xs">{j.taskId}</code>
                  <Badge>{j.status}</Badge>
                  {j.provider && <Badge className="bg-zinc-100">{j.provider}</Badge>}
                  <span className="text-xs text-muted-foreground">@{j.agentName}</span>
                </div>
                {j.error && <p className="text-xs text-red-600">{j.error}</p>}
                {j.resultSummary && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{j.resultSummary}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="border border-border rounded-lg p-4 flex flex-col gap-3">
        <h2 className="font-medium text-sm">啟動 / 對話</h2>
        {activeRun && (
          <div className="flex items-center gap-2 text-sm">
            <Badge>{activeRun.status}</Badge>
            <span className="text-muted-foreground">phase: {activeRun.phase}</span>
            <span className="text-xs text-muted-foreground truncate">{activeRun.goal}</span>
          </div>
        )}
        {runEnded && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            此 Run 已{activeRun?.status === 'stopped' ? '停止' : '完成'}，無法再「繼續」。
            請下方重新啟動一次新的 Auto Run（已帶入上次目標，可直接改）。
          </p>
        )}
        {!runLive && (
          <>
            <Label>目標</Label>
            <Textarea
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="描述目標（可模糊）。若要跳過澄清立刻開工，可寫「立刻開始…」"
            />
            <Button onClick={start} disabled={busy || !goal.trim()}>
              {runEnded ? '重新啟動 Auto Run' : '啟動 Auto Run'}
            </Button>
          </>
        )}
        {runLive && activeRun && (
          <>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || activeRun.status === 'paused'}
                onClick={() => runAction('暫停', () => autoApi.pause(activeRun.id).then(load))}
              >
                暫停
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || activeRun.status !== 'paused'}
                onClick={() =>
                  runAction('繼續', () =>
                    autoApi.resume(activeRun.id).then(() => refreshRun(activeRun.id)),
                  )
                }
              >
                繼續
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => runAction('停止', () => autoApi.stop(activeRun.id).then(load))}
              >
                停止
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  runAction('推進', async () => {
                    const result = await autoApi.tick(activeRun.id);
                    if (result.run) {
                      setRuns((prev) =>
                        prev.map((r) => (r.id === result.run.id ? { ...r, ...result.run } : r)),
                      );
                    }
                    if (result.messages) setMessages(result.messages);
                    await refreshRun(activeRun.id);
                    await load();
                  })
                }
              >
                推進一步
              </Button>
            </div>
            <AutoChatThread messages={messages} className="h-80" />
            <div className="flex gap-2">
              <Input
                value={chat}
                onChange={(e) => setChat(e.target.value)}
                placeholder={
                  decisions.some((d) => d.status === 'open')
                    ? '決策：回 1 / 選項原文 /「自訂：…」；或僅留言'
                    : activeRun.phase === 'research'
                      ? '研究員分析中；可補充需求，或回「開始工作」讓研究後直接開工'
                      : activeRun.phase === 'clarify' || activeRun.phase === 'intake'
                        ? '補充需求；對齊後回「開始工作」才會開工'
                        : '補充指示；執行中不會重規劃（回「重新規劃」才會）'
                }
                onKeyDown={(e) => e.key === 'Enter' && send()}
              />
              <Button onClick={send} disabled={busy || !chat.trim()}>
                發送
              </Button>
            </div>
          </>
        )}
        {runEnded && messages.length > 0 && (
          <AutoChatThread messages={messages} className="h-48" />
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        分派結果請到{' '}
        <Link className="underline" to={`/projects/${projectId}/tasks`}>
          任務看板
        </Link>
        ；員工與提示詞在{' '}
        <Link className="underline" to={`/projects/${projectId}/agents`}>
          AI 員工
        </Link>
        。
      </p>
    </div>
  );
}
