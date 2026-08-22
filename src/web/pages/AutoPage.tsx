import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  autoApi,
  projectsApi,
  AutoRun,
  AutoRunMessage,
  Decision,
  ReviewPolicy,
  Project,
} from '../lib/api';
import { Button, Input, Textarea, Label, Badge } from '../components/ui';

export function AutoPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
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
    }>
  >([]);
  const [runnerConfigured, setRunnerConfigured] = useState(false);
  const [runnerProvider, setRunnerProvider] = useState<'cursor' | 'opencode'>('cursor');
  const [goal, setGoal] = useState('');
  const [chat, setChat] = useState('');
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    const [p, r, pol, openDec, runner] = await Promise.all([
      projectsApi.get(projectId),
      autoApi.listRuns(projectId),
      autoApi.getPolicy(projectId),
      autoApi.listDecisions(projectId, 'open'),
      autoApi.runnerStatus(projectId).catch(() => null),
    ]);
    setProject(p);
    setRuns(r);
    setPolicy(pol);
    setDecisions(openDec);
    if (runner) {
      setRunnerConfigured(runner.configured);
      setRunnerProvider(runner.provider);
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
      if (!live) {
        setGoal((g) => g.trim() || active.goal || '');
      }
    } else {
      setActiveRunId(null);
      setMessages([]);
    }
  }, [projectId]);

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
          setRunnerProvider(runner.provider);
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
      }
    }, 4000);
    return () => clearInterval(t);
  }, [projectId, activeRunId, runnerJobs]);

  const refreshRun = async (runId: string) => {
    const detail = await autoApi.getRun(runId);
    setMessages(detail.messages);
    setDecisions(detail.decisions);
    setRuns(await autoApi.listRuns(projectId!));
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

  const setMode = async (mode: 'manual' | 'auto') => {
    if (!projectId) return;
    await projectsApi.update(projectId, { run_mode: mode });
    await load();
  };

  const confirmPolicy = async () => {
    if (!projectId || !policy) return;
    await autoApi.updatePolicy(projectId, policy, true);
    await load();
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
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold">Auto 工作台</h1>
        <p className="text-sm text-muted-foreground mt-1">
          與協調者先對齊需求；確認後再進審查協定、建員工與分派。模糊目標請多聊幾輪，回覆「開始工作」才開工。
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="border border-border rounded-lg p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">運行模式</h2>
          <Badge>{project?.runMode ?? 'manual'}</Badge>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={project?.runMode === 'manual' ? undefined : 'ghost'}
            onClick={() => setMode('manual')}
          >
            手動
          </Button>
          <Button
            size="sm"
            variant={project?.runMode === 'auto' ? undefined : 'ghost'}
            onClick={() => setMode('auto')}
          >
            Auto
          </Button>
        </div>
      </section>

      <section className="border border-border rounded-lg p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Review Policy</h2>
          <Badge className={policy?.confirmed ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100'}>
            {policy?.confirmed ? '已確認' : '待確認'}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground whitespace-pre-wrap">
          {policy?.human_verify_notes}
        </p>
        <p className="text-xs">預設審查：{policy?.default_reviewer_type}</p>
        {!policy?.confirmed && (
          <Button size="sm" onClick={confirmPolicy}>
            確認協定
          </Button>
        )}
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
            <Badge className={runnerConfigured ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100'}>
              {runnerConfigured
                ? runnerProvider === 'opencode'
                  ? 'GLM Key 可用'
                  : 'Cursor Key 可用'
                : runnerProvider === 'opencode'
                  ? '缺少 ZAI_API_KEY'
                  : '缺少 CURSOR_API_KEY'}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          在 <code>.env</code> 设置 <code>RUNNER_PROVIDER=cursor</code> 或{' '}
          <code>opencode</code>。OpenCode 使用官方{' '}
          <code>@opencode-ai/sdk</code>，复用 GLM 的 <code>ZAI_API_KEY</code>
          ；本机 PATH 需有 <code>opencode</code>（SDK 会启动 serve）。
        </p>
        {runnerJobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">尚無執行任務。分派後會自動排隊。</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {runnerJobs.slice(0, 12).map((j) => (
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
                  runAction('推進', () =>
                    autoApi.tick(activeRun.id).then(() => refreshRun(activeRun.id)),
                  )
                }
              >
                推進一步
              </Button>
            </div>
            <div className="max-h-80 overflow-y-auto flex flex-col gap-2 border border-border rounded-md p-3 bg-zinc-50">
              {messages.map((m) => (
                <div key={m.id} className="text-sm">
                  <span className="text-xs text-muted-foreground uppercase mr-2">{m.role}</span>
                  <span className="whitespace-pre-wrap">{m.content}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={chat}
                onChange={(e) => setChat(e.target.value)}
                placeholder={
                  decisions.some((d) => d.status === 'open')
                    ? '決策：回 1 / 選項原文 /「自訂：…」；或僅留言'
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
          <div className="max-h-48 overflow-y-auto flex flex-col gap-2 border border-border rounded-md p-3 bg-zinc-50">
            {messages.map((m) => (
              <div key={m.id} className="text-sm">
                <span className="text-xs text-muted-foreground uppercase mr-2">{m.role}</span>
                <span className="whitespace-pre-wrap">{m.content}</span>
              </div>
            ))}
          </div>
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
