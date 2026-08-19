import { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { tasksApi, Task } from '../lib/api';
import { Button, Badge, Input, Textarea, Label, Dialog } from '../components/ui';
import { formatRelativeTime, statusLabel, statusColor } from '../lib/utils';

export function TaskDetailPage() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [constraints, setConstraints] = useState('');
  const [agentNotes, setAgentNotes] = useState('');
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [commentSending, setCommentSending] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    if (!projectId || !taskId) return;
    const data = await tasksApi.get(projectId, taskId);
    setTask(data);
    setTitle(data.title);
    setGoal((data as Task & { goal?: string }).goal ?? '');
    setAcceptanceCriteria((data as Task & { acceptance_criteria?: string }).acceptance_criteria ?? '');
    setConstraints((data as Task & { constraints?: string }).constraints ?? '');
    setAgentNotes((data as Task & { agent_notes?: string }).agent_notes ?? '');
    setSaved(true);
  }, [projectId, taskId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, task?.status === 'in_progress' ? 3000 : 8000);
    return () => clearInterval(interval);
  }, [load, task?.status]);

  const isLocked = task?.status === 'in_progress' || (task?.status === 'done' && task?.humanReviewed);
  const isDraft = task?.status === 'draft';
  const isPendingReview = task?.status === 'done' && !task?.humanReviewed;
  const canPublish = isDraft && title.trim() && acceptanceCriteria.trim();

  const scheduleSave = (updates: {
    title?: string;
    goal?: string;
    acceptance_criteria?: string;
    constraints?: string;
    agent_notes?: string;
  }) => {
    if (isLocked || !task || !projectId || !taskId) return;
    setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const updated = await tasksApi.update(projectId, taskId, {
          ...updates,
          expected_version: task.version,
        });
        setTask(updated);
        setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : '儲存失敗');
      }
    }, 800);
  };

  const handleFieldChange = (
    field: 'title' | 'goal' | 'acceptance_criteria' | 'constraints' | 'agent_notes',
    value: string,
  ) => {
    if (field === 'title') setTitle(value);
    if (field === 'goal') setGoal(value);
    if (field === 'acceptance_criteria') setAcceptanceCriteria(value);
    if (field === 'constraints') setConstraints(value);
    if (field === 'agent_notes') setAgentNotes(value);
    scheduleSave({ [field]: value });
  };

  const doAction = async (action: string, fn: () => Promise<Task>) => {
    setActionLoading(action);
    setError('');
    try {
      const updated = await fn();
      setTask(updated);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失敗');
    } finally {
      setActionLoading('');
    }
  };

  if (!task) return <div className="text-muted-foreground">載入中…</div>;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-4">
        <Link
          to={`/projects/${projectId}/tasks`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← 任務
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
            <Badge className={statusColor(task.status, task.humanReviewed)}>
              {isPendingReview ? '待你驗收' : statusLabel(task.status)}
            </Badge>
            {!saved && <span className="text-xs text-muted-foreground">儲存中…</span>}
            {saved && !isLocked && <span className="text-xs text-muted-foreground">已儲存</span>}
          </div>
          {isDraft && (
            <Input
              value={title}
              onChange={(e) => handleFieldChange('title', e.target.value)}
              className="text-lg font-semibold border-none px-0 focus-visible:ring-0"
              placeholder="任務標題"
            />
          )}
          {!isDraft && <h1 className="text-lg font-semibold">{task.title}</h1>}
          <p className="text-xs text-muted-foreground mt-1">
            更新於 {formatRelativeTime(task.updatedAt)}
            {isDraft && ' · 尚未交給 Agent'}
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-2 mb-6 flex-wrap">
        {isDraft && (
          <Button
            onClick={() => doAction('publish', () => tasksApi.publish(projectId!, taskId!))}
            disabled={!canPublish || actionLoading === 'publish'}
          >
            交給 Agent
          </Button>
        )}
        {isPendingReview && (
          <>
            <Button
              onClick={() => doAction('approve', () => tasksApi.approve(projectId!, taskId!))}
              disabled={!!actionLoading}
            >
              驗收通過
            </Button>
            <Button variant="outline" onClick={() => setShowReject(true)}>
              打回
            </Button>
          </>
        )}
        {(task.status === 'cancelled') && (
          <Button
            variant="outline"
            onClick={() => doAction('reopen', () => tasksApi.reopen(projectId!, taskId!))}
            disabled={!!actionLoading}
          >
            重開
          </Button>
        )}
        {task.status !== 'cancelled' && task.status !== 'done' && (
          <Button variant="ghost" onClick={() => setShowCancel(true)}>
            取消任務
          </Button>
        )}
        {task.lease && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => doAction('unlock', () => tasksApi.unlock(projectId!, taskId!))}
          >
            強制解鎖
          </Button>
        )}
      </div>

      {isDraft && !canPublish && (
        <p className="text-xs text-amber-600 mb-4">
          交給 Agent 前需填寫：{!title.trim() && '標題 '}{!acceptanceCriteria.trim() && '驗收標準'}
        </p>
      )}

      {isLocked && (
        <p className="text-xs text-muted-foreground mb-4">
          規格已鎖定{task.status === 'in_progress' ? ' · Agent 處理中' : ''}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 flex flex-col gap-5">
          <Field
            label="目標"
            agentVisible={!isDraft}
            locked={isLocked}
            value={goal}
            onChange={(v) => handleFieldChange('goal', v)}
          />
          <Field
            label="驗收標準"
            required={isDraft}
            agentVisible={!isDraft}
            locked={isLocked}
            value={acceptanceCriteria}
            onChange={(v) => handleFieldChange('acceptance_criteria', v)}
            multiline
          />
          <Field
            label="約束與範圍"
            agentVisible={!isDraft}
            locked={isLocked}
            value={constraints}
            onChange={(v) => handleFieldChange('constraints', v)}
            multiline
          />
          <Field
            label="給 Agent 的補充說明"
            agentVisible
            locked={isLocked}
            value={agentNotes}
            onChange={(v) => handleFieldChange('agent_notes', v)}
            multiline
          />

          {(task as Task & { result_note?: string }).result_note && (
            <div>
              <Label>Agent 完成說明</Label>
              <p className="mt-1 text-sm bg-muted rounded-md p-3">
                {(task as Task & { result_note?: string }).result_note}
              </p>
            </div>
          )}

          {(task as Task & { artifacts?: string[] }).artifacts &&
            (task as Task & { artifacts?: string[] }).artifacts!.length > 0 && (
              <div>
                <Label>產出檔案</Label>
                <ul className="mt-1 text-sm font-mono">
                  {(task as Task & { artifacts?: string[] }).artifacts!.map((a) => (
                    <li key={a} className="text-muted-foreground">{a}</li>
                  ))}
                </ul>
              </div>
            )}
        </div>

        <div className="flex flex-col gap-4">
          <section className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold mb-3">狀態與時間</h3>
            <dl className="text-xs flex flex-col gap-2">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Workspace</dt>
                <dd className="font-mono text-right truncate max-w-[160px]" title={task.workspacePath}>
                  {task.workspacePath}
                </dd>
              </div>
              {task.claimedBy && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">認領者</dt>
                  <dd>{task.claimedBy}</dd>
                </div>
              )}
              {task.completedAt && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">完成時間</dt>
                  <dd>{formatRelativeTime(task.completedAt)}</dd>
                </div>
              )}
            </dl>
          </section>

          {task.lease && (
            <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <h3 className="text-sm font-semibold text-amber-700 mb-1">Agent 佔用中</h3>
              <p className="text-xs text-amber-600">
                {task.lease.agentName} · 到期 {formatRelativeTime(task.lease.expiresAt)}
              </p>
            </section>
          )}

          {task.activities && task.activities.filter((a) => a.action !== 'commented').length > 0 && (
            <section className="rounded-lg border border-border p-4">
              <h3 className="text-sm font-semibold mb-3">Agent 活動</h3>
              <div className="flex flex-col gap-2">
                {[...task.activities].filter((a) => a.action !== 'commented').reverse().map((a) => (
                  <div key={a.id} className="text-xs">
                    <span className="text-muted-foreground">{formatRelativeTime(a.at)}</span>
                    {' · '}
                    <span>{a.actorName ?? a.actor}</span>
                    {a.summary && <> · {a.summary}</>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {(task as Task & { rejections?: Array<{ reason: string; at: string }> }).rejections &&
            (task as Task & { rejections?: Array<{ reason: string; at: string }> }).rejections!.length > 0 && (
              <section className="rounded-lg border border-border p-4">
                <h3 className="text-sm font-semibold mb-3">打回記錄</h3>
                {(task as Task & { rejections?: Array<{ reason: string; at: string }> }).rejections!.map((r, i) => (
                  <div key={i} className="text-xs mb-2">
                    <span className="text-muted-foreground">{formatRelativeTime(r.at)}</span>
                    <p className="mt-0.5">{r.reason}</p>
                  </div>
                ))}
              </section>
            )}
        </div>
      </div>

      <section className="mt-8 rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold mb-3">評論</h2>
        <div className="flex flex-col gap-3 mb-4">
          {(task.comments ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">還沒有評論。人和 Agent 都可以在這裡留言。</p>
          )}
          {(task.comments ?? []).map((c) => {
            const name = c.actor_name ?? c.actorName ?? (c.actor === 'agent' ? 'Agent' : '你');
            const isAgent = c.actor === 'agent';
            return (
              <div key={c.id} className="rounded-md border border-border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Badge className={isAgent ? 'text-amber-700 border-amber-300 bg-amber-50' : 'text-zinc-600 border-zinc-300 bg-zinc-50'}>
                    {isAgent ? `Agent · ${name}` : '你'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{formatRelativeTime(c.at)}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{c.body}</p>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-2">
          <Textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            rows={3}
            placeholder="寫一則評論…"
          />
          <div className="flex justify-end">
            <Button
              disabled={!commentDraft.trim() || commentSending}
              onClick={async () => {
                if (!projectId || !taskId || !commentDraft.trim()) return;
                setCommentSending(true);
                setError('');
                try {
                  await tasksApi.addComment(projectId, taskId, commentDraft.trim());
                  setCommentDraft('');
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '發送失敗');
                } finally {
                  setCommentSending(false);
                }
              }}
            >
              {commentSending ? '發送中…' : '發送評論'}
            </Button>
          </div>
        </div>
      </section>

      <Dialog open={showReject} onClose={() => setShowReject(false)} title="打回任務">
        <div className="flex flex-col gap-3">
          <Label>打回原因（必填）</Label>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            placeholder="說明哪裡不符合驗收標準…"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowReject(false)}>取消</Button>
            <Button
              disabled={!rejectReason.trim() || !!actionLoading}
              onClick={() => {
                doAction('reject', () =>
                  tasksApi.reject(projectId!, taskId!, rejectReason.trim()),
                ).then(() => {
                  setShowReject(false);
                  setRejectReason('');
                });
              }}
            >
              確認打回
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={showCancel} onClose={() => setShowCancel(false)} title="取消任務">
        <div className="flex flex-col gap-3">
          <Label>取消原因（可選）</Label>
          <Textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            rows={2}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowCancel(false)}>返回</Button>
            <Button
              variant="destructive"
              onClick={() => {
                doAction('cancel', () =>
                  tasksApi.cancel(projectId!, taskId!, cancelReason.trim() || undefined),
                ).then(() => {
                  setShowCancel(false);
                });
              }}
            >
              確認取消
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  locked,
  agentVisible,
  required,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  locked?: boolean;
  agentVisible?: boolean;
  required?: boolean;
  multiline?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Label>{label}{required && ' *'}</Label>
        {agentVisible && (
          <span className="text-xs text-blue-500 border border-blue-200 rounded px-1">
            Agent 可見
          </span>
        )}
        {!agentVisible && (
          <span className="text-xs text-zinc-400 border border-zinc-200 rounded px-1">
            僅草稿
          </span>
        )}
      </div>
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={locked}
          rows={4}
          placeholder={`填寫${label}…`}
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={locked}
          placeholder={`填寫${label}…`}
        />
      )}
    </div>
  );
}
