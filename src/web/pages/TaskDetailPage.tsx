import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Diff, Hunk, parseDiff } from 'react-diff-view';
import { tasksApi, projectsApi, Task, Project, TaskChangesSummary, FileDiffResponse, TaskGitStatus, RunnerLogEntry, RunnerJobInfo } from '../lib/api';
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
  const [showDelete, setShowDelete] = useState(false);
  const [forceDelete, setForceDelete] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [commentSending, setCommentSending] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [useIsolation, setUseIsolation] = useState(false);
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
    setUseIsolation(data.use_isolation ?? false);
    setSaved(true);
  }, [projectId, taskId]);

  useEffect(() => {
    if (!projectId) return;
    projectsApi.get(projectId).then(setProject).catch(() => setProject(null));
  }, [projectId]);

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
    use_isolation?: boolean;
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
        {task.status !== 'in_progress' && (
          <Button variant="destructive" onClick={() => { setForceDelete(false); setShowDelete(true); }}>
            刪除任務
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

      {isPendingReview && (
        <ChangesPanel projectId={projectId!} taskId={taskId!} task={task} />
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

          {isDraft && (
            <section className="rounded-lg border border-blue-200 bg-blue-50/50 p-4">
              <h3 className="text-sm font-semibold text-blue-900 mb-2">Git 隔離（worktree）</h3>
              <label
                className={`flex items-start gap-2 text-sm ${project?.gitRoot ? 'cursor-pointer' : 'cursor-not-allowed'}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={project?.gitRoot ? useIsolation : false}
                  disabled={isLocked || !project?.gitRoot}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setUseIsolation(checked);
                    scheduleSave({ use_isolation: checked });
                  }}
                />
                <span>
                  交給 Agent 時建立獨立 branch 與 worktree
                  <span className="block text-xs text-muted-foreground mt-1">
                    {project?.gitRoot ? (
                      <>
                        已偵測 git：
                        <code className="font-mono text-[11px] break-all">{project.gitRoot}</code>
                      </>
                    ) : project === null ? (
                      '正在檢查 git 倉庫…'
                    ) : (
                      '此 workspace 未偵測到 git 倉庫，無法使用 worktree 隔離'
                    )}
                  </span>
                </span>
              </label>
            </section>
          )}

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

          <IsolationPanel
            task={task}
            projectId={projectId!}
            actionLoading={actionLoading}
            onAction={doAction}
            onRefresh={load}
          />

          <PreviewPanel
            task={task}
            projectId={projectId!}
            project={project}
            actionLoading={actionLoading}
            onAction={doAction}
            onRefresh={load}
          />

          <RunnerLogPanel task={task} projectId={projectId!} />

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

      <Dialog open={showDelete} onClose={() => setShowDelete(false)} title="刪除任務">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            將永久刪除任務 <span className="font-mono">{task.id}</span> 及其評論、活動記錄。
            {(task.git_branch || task.worktree_path || task.use_isolation) && (
              <>
                {' '}
                若已建立 Git 隔離，會一併移除 worktree 與任務分支（
                <span className="font-mono">{task.git_branch ?? `pm-ai/${task.id}`}</span>）。
              </>
            )}
          </p>
          {(task.git_branch || task.worktree_path || task.use_isolation) && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={forceDelete}
                onChange={(e) => setForceDelete(e.target.checked)}
              />
              <span>
                強制刪除：若 worktree 被 Cursor 或 dev server 占用無法刪除，仍移除任務記錄（目錄需稍後手動清理）
              </span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowDelete(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={!!actionLoading}
              onClick={async () => {
                if (!projectId || !taskId) return;
                setActionLoading('delete');
                setError('');
                try {
                  const result = await tasksApi.delete(projectId, taskId, { force: forceDelete });
                  if (result.warnings?.length) {
                    toast.warning(result.warnings.join(' '));
                  } else {
                    toast.success('任務已刪除');
                  }
                  navigate(`/projects/${projectId}/tasks`);
                } catch (err) {
                  setError(err instanceof Error ? err.message : '刪除失敗');
                  setShowDelete(false);
                } finally {
                  setActionLoading('');
                }
              }}
            >
              {actionLoading === 'delete' ? '刪除中…' : '確認刪除'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function ChangesPanel({
  projectId,
  taskId,
  task,
}: {
  projectId: string;
  taskId: string;
  task: Task;
}) {
  const [summary, setSummary] = useState<TaskChangesSummary | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    tasksApi
      .getChanges(projectId, taskId)
      .then((data) => {
        setSummary(data);
        setSelectedPath(data.files[0]?.path ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '載入變更失敗'))
      .finally(() => setLoading(false));
  }, [projectId, taskId]);

  useEffect(() => {
    if (!selectedPath) {
      setFileDiff(null);
      return;
    }
    setDiffLoading(true);
    tasksApi
      .getChangeDiff(projectId, taskId, selectedPath)
      .then(setFileDiff)
      .catch((err) => setError(err instanceof Error ? err.message : '載入 diff 失敗'))
      .finally(() => setDiffLoading(false));
  }, [projectId, taskId, selectedPath]);

  const parsedDiffs = useMemo(() => {
    if (!fileDiff?.patch) return [];
    try {
      return parseDiff(fileDiff.patch);
    } catch {
      return [];
    }
  }, [fileDiff?.patch]);

  const statusColor = (status: string) => {
    if (status === 'A' || status === '?') return 'text-green-700';
    if (status === 'D') return 'text-red-600';
    return 'text-amber-700';
  };

  const artifacts = (task as Task & { artifacts?: string[] }).artifacts ?? [];

  if (loading) {
    return (
      <section className="rounded-lg border border-border p-4 mb-6">
        <p className="text-sm text-muted-foreground">載入程式碼變更…</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border p-4 mb-6">
      <h3 className="text-sm font-semibold mb-2">程式碼變更</h3>

      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      {summary && summary.mode !== 'none' && (
        <div className="text-xs text-muted-foreground mb-3 flex flex-wrap gap-x-3 gap-y-1">
          <span>{summary.base_label} → {summary.head_label}</span>
          <span className="text-green-700">+{summary.stats.additions}</span>
          <span className="text-red-600">-{summary.stats.deletions}</span>
          <span>{summary.stats.files} 個檔案</span>
          {summary.has_uncommitted && <span className="text-amber-600">含未提交變更</span>}
        </div>
      )}

      {summary?.warning && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
          {summary.warning}
        </p>
      )}

      {summary && summary.files.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          <p>沒有偵測到 git 變更。</p>
          {artifacts.length > 0 && (
            <div className="mt-2">
              <p className="text-xs mb-1">Agent 回報的產出：</p>
              <ul className="font-mono text-xs">
                {artifacts.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[minmax(140px,220px)_1fr] gap-3 min-h-[280px]">
          <div className="border border-border rounded overflow-auto max-h-[480px]">
            {summary?.files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedPath(file.path)}
                className={`w-full text-left px-2 py-1.5 text-xs font-mono border-b border-border last:border-b-0 hover:bg-muted ${
                  selectedPath === file.path ? 'bg-muted' : ''
                }`}
              >
                <span className={`mr-1 ${statusColor(file.status)}`}>{file.status}</span>
                <span className="break-all">{file.path}</span>
                {!file.binary && (
                  <span className="block text-[10px] text-muted-foreground mt-0.5">
                    +{file.additions} -{file.deletions}
                  </span>
                )}
                {file.binary && (
                  <span className="block text-[10px] text-muted-foreground mt-0.5">binary</span>
                )}
              </button>
            ))}
          </div>

          <div className="border border-border rounded overflow-auto max-h-[480px] bg-white">
            {diffLoading && (
              <p className="text-xs text-muted-foreground p-3">載入 diff…</p>
            )}
            {!diffLoading && fileDiff && (
              <>
                <div className="text-[11px] text-muted-foreground px-3 py-2 border-b border-border sticky top-0 bg-white">
                  {fileDiff.old_label} | {fileDiff.new_label}
                </div>
                {fileDiff.binary || fileDiff.too_large ? (
                  <p className="text-sm text-muted-foreground p-3">
                    此檔案為二進位或過大，請在 Cursor 中開啟檢視。
                  </p>
                ) : !fileDiff.patch ? (
                  <p className="text-sm text-muted-foreground p-3">此檔案沒有可顯示的文字 diff。</p>
                ) : parsedDiffs.length === 0 ? (
                  <pre className="text-[11px] font-mono p-3 whitespace-pre-wrap">{fileDiff.patch}</pre>
                ) : (
                  <div className="diff-panel text-[11px]">
                    {parsedDiffs.map((file) => (
                      <Diff
                        key={`${file.oldPath}-${file.newPath}`}
                        viewType="split"
                        diffType={file.type}
                        hunks={file.hunks}
                      >
                        {(hunks) =>
                          hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)
                        }
                      </Diff>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const RUNNER_STATUS_LABEL: Record<string, string> = {
  queued: '排隊中',
  claiming: '認領中',
  running: '執行中',
  completed: '已完成',
  failed: '失敗',
  cancelled: '已取消',
};

const LOG_KIND_LABEL: Record<RunnerLogEntry['kind'], string> = {
  system: '系統',
  assistant: 'Agent',
  tool: '工具',
  thinking: '思考',
  error: '錯誤',
};

function coalesceLogEntries(entries: RunnerLogEntry[]): RunnerLogEntry[] {
  const result: RunnerLogEntry[] = [];
  for (const entry of entries) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.kind === entry.kind &&
      (entry.kind === 'assistant' || entry.kind === 'thinking')
    ) {
      if (entry.text.startsWith(prev.text)) {
        prev.text = entry.text;
      } else if (!prev.text.endsWith(entry.text)) {
        prev.text = `${prev.text}${entry.text}`;
      }
      prev.at = entry.at;
      continue;
    }
    result.push({ ...entry });
  }
  return result;
}

function RunnerLogPanel({ task, projectId }: { task: Task; projectId: string }) {
  const [entries, setEntries] = useState<RunnerLogEntry[]>([]);
  const [job, setJob] = useState<RunnerJobInfo | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [expanded, setExpanded] = useState(true);
  const latestSeqRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const isActive =
    task.status === 'in_progress' ||
    ['queued', 'claiming', 'running'].includes(job?.status ?? '');

  const mergeEntries = useCallback((incoming: RunnerLogEntry[]) => {
    if (incoming.length === 0) return;
    setEntries((prev) => {
      const bySeq = new Map(prev.map((e) => [e.seq, { ...e }]));
      for (const entry of incoming) {
        bySeq.set(entry.seq, { ...entry });
      }
      const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      const coalesced = coalesceLogEntries(merged);
      if (coalesced.length > 500) return coalesced.slice(-500);
      return coalesced;
    });
    const maxSeq = Math.max(...incoming.map((e) => e.seq));
    if (maxSeq > latestSeqRef.current) latestSeqRef.current = maxSeq;
  }, []);

  useEffect(() => {
    let cancelled = false;
    tasksApi
      .getRunnerLogs(projectId, task.id, latestSeqRef.current)
      .then((data) => {
        if (cancelled) return;
        mergeEntries(data.entries);
        setJob(data.job);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, task.id, mergeEntries]);

  useEffect(() => {
    if (!isActive) {
      setStreaming(false);
      return;
    }

    setExpanded(true);
    setStreamError('');
    const controller = new AbortController();
    setStreaming(true);

    void tasksApi.streamRunnerLogs(
      projectId,
      task.id,
      {
        onInit: (data) => {
          mergeEntries(data.entries);
          latestSeqRef.current = data.latestSeq;
          setJob(data.job);
        },
        onLog: (entry) => {
          mergeEntries([entry]);
        },
        onDone: (data) => {
          setJob(data.job);
          setStreaming(false);
        },
        onError: (err) => {
          setStreamError(err.message);
          setStreaming(false);
        },
      },
      { sinceSeq: latestSeqRef.current, signal: controller.signal },
    );

    return () => {
      controller.abort();
      setStreaming(false);
    };
  }, [projectId, task.id, isActive, mergeEntries]);

  useEffect(() => {
    if (expanded) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [entries, expanded]);

  if (entries.length === 0 && !isActive && !job) return null;

  const jobStatus = job?.status ?? (task.status === 'in_progress' ? 'running' : null);

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold">AI 工作流</h3>
        <div className="flex items-center gap-2">
          {jobStatus && (
            <Badge className={jobStatus === 'running' ? 'bg-amber-100 text-amber-800' : 'bg-zinc-100'}>
              {RUNNER_STATUS_LABEL[jobStatus] ?? jobStatus}
            </Badge>
          )}
          {streaming && <span className="text-[11px] text-green-700">即時串流中</span>}
        </div>
      </div>

      {job && (
        <dl className="text-xs flex flex-col gap-1 mb-3">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground shrink-0">執行者</dt>
            <dd>{job.agentName}</dd>
          </div>
          {job.provider && (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground shrink-0">Provider</dt>
              <dd className="font-mono">{job.provider}</dd>
            </div>
          )}
          {job.error && (
            <div className="text-red-600 whitespace-pre-wrap">{job.error}</div>
          )}
        </dl>
      )}

      {streamError && (
        <p className="text-xs text-amber-700 mb-2">
          串流中斷：{streamError}（仍會顯示已收到的日誌）
        </p>
      )}

      {entries.length > 0 && (
        <>
          <Button size="sm" variant="ghost" className="mb-2" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收合輸出' : '展開輸出'}
          </Button>
          {expanded && (
            <div className="rounded bg-muted max-h-72 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
              {entries.map((entry) => (
                <div key={entry.seq} className="mb-2 last:mb-0">
                  <div className="text-muted-foreground mb-0.5">
                    {formatRelativeTime(entry.at)}
                    {' · '}
                    <span
                      className={
                        entry.kind === 'error'
                          ? 'text-red-600'
                          : entry.kind === 'tool'
                            ? 'text-blue-700'
                            : entry.kind === 'assistant'
                              ? 'text-amber-800'
                              : ''
                      }
                    >
                      {LOG_KIND_LABEL[entry.kind]}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words">{entry.text}</pre>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </>
      )}

      {entries.length === 0 && isActive && (
        <p className="text-xs text-muted-foreground">Agent 正在啟動，等待工作流輸出…</p>
      )}
    </section>
  );
}

function PreviewPanel({
  task,
  projectId,
  project,
  actionLoading,
  onAction,
  onRefresh,
}: {
  task: Task;
  projectId: string;
  project: Project | null;
  actionLoading: string;
  onAction: (action: string, fn: () => Promise<Task>) => void;
  onRefresh: () => Promise<void>;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const preview = task.preview;
  const status = preview?.status ?? 'stopped';
  const isActive = status === 'running' || status === 'starting';
  const cwd = preview?.cwd ?? task.execution_path ?? task.workspacePath;
  const canControl = task.status !== 'cancelled';

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => {
      void onRefresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [isActive, onRefresh]);

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // ignore
    }
  };

  const statusLabel =
    status === 'running'
      ? '運行中'
      : status === 'starting'
        ? '啟動中…'
        : status === 'error'
          ? '錯誤'
          : '已停止';

  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold mb-3">調試預覽</h3>
      <dl className="text-xs flex flex-col gap-2 mb-3">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground shrink-0">狀態</dt>
          <dd>
            {status === 'running' && <span className="text-green-700">{statusLabel}</span>}
            {status === 'starting' && <span className="text-amber-600">{statusLabel}</span>}
            {status === 'error' && <span className="text-red-600">{statusLabel}</span>}
            {status === 'stopped' && <span className="text-muted-foreground">{statusLabel}</span>}
          </dd>
        </div>
        {cwd && (
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">工作目錄</dt>
            <dd className="font-mono text-[11px] break-all">{cwd}</dd>
          </div>
        )}
        {preview?.port != null && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground shrink-0">端口</dt>
            <dd className="font-mono">{preview.port}</dd>
          </div>
        )}
        {preview?.command && (
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">命令</dt>
            <dd className="font-mono text-[11px] break-all">{preview.command}</dd>
          </div>
        )}
      </dl>

      {preview?.url && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-600 hover:underline font-mono"
          >
            {preview.url}
          </a>
          <Button size="sm" variant="ghost" onClick={() => copyText(preview.url!)}>
            複製
          </Button>
        </div>
      )}

      {preview?.error && (
        <p className="text-xs text-red-600 mb-3 whitespace-pre-wrap">{preview.error}</p>
      )}

      {(status === 'running' || status === 'starting') && (
        <p className="text-xs text-muted-foreground mb-3">
          若頁面暫時打不開，請稍等幾秒或查看下方日誌。
        </p>
      )}

      <div className="flex flex-col gap-2">
        {canControl && status !== 'running' && status !== 'starting' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAction('preview-start', () => tasksApi.startPreview(projectId, task.id))}
            disabled={actionLoading === 'preview-start'}
          >
            啟動調試服務
          </Button>
        )}
        {canControl && (status === 'running' || status === 'starting' || status === 'error') && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onAction('preview-stop', () => tasksApi.stopPreview(projectId, task.id))}
            disabled={actionLoading === 'preview-stop'}
          >
            停止
          </Button>
        )}
        {(preview?.log_tail?.length ?? 0) > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? '隱藏日誌' : '顯示最近日誌'}
          </Button>
        )}
      </div>

      {showLogs && (preview?.log_tail?.length ?? 0) > 0 && (
        <pre className="mt-3 text-[11px] font-mono bg-muted rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap">
          {preview!.log_tail.join('\n')}
        </pre>
      )}

      <p className="text-xs text-muted-foreground mt-3">
        啟動命令在{' '}
        <Link to={`/projects/${projectId}/settings`} className="text-blue-600 hover:underline">
          專案設定
        </Link>
        {project?.previewCommand ? (
          <>（目前：<code className="font-mono">{project.previewCommand}</code>）</>
        ) : null}
      </p>
    </section>
  );
}

function IsolationPanel({
  task,
  projectId,
  actionLoading,
  onAction,
  onRefresh,
}: {
  task: Task;
  projectId: string;
  actionLoading: string;
  onAction: (action: string, fn: () => Promise<Task>) => void;
  onRefresh: () => Promise<void>;
}) {
  const showPanel =
    task.use_isolation ||
    task.isolation_status !== 'none' ||
    !!task.git_branch ||
    !!task.worktree_path;

  const [gitStatus, setGitStatus] = useState<TaskGitStatus | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const [mergeConflicts, setMergeConflicts] = useState<string[]>([]);
  const [mergeError, setMergeError] = useState('');
  const [confirmRemoveWorktree, setConfirmRemoveWorktree] = useState(false);
  const [confirmDeleteBranch, setConfirmDeleteBranch] = useState(false);
  const [confirmRestoreWorktree, setConfirmRestoreWorktree] = useState(false);
  const [localLoading, setLocalLoading] = useState('');

  const pendingReview = isPendingReview(task);
  const reviewed = task.status === 'done' && task.humanReviewed;
  const showGitOps = task.status === 'done' && !!task.git_branch;
  const showGitStatus = !!task.git_branch;

  const loadGitStatus = useCallback(async () => {
    if (!showGitStatus) {
      setGitStatus(null);
      return;
    }
    try {
      const status = await tasksApi.getGitStatus(projectId, task.id);
      setGitStatus(status);
      setMergeTarget((prev) => {
        if (prev && status.merge_targets.includes(prev)) return prev;
        if (status.default_merge_target && status.merge_targets.includes(status.default_merge_target)) {
          return status.default_merge_target;
        }
        return status.merge_targets[0] ?? '';
      });
    } catch {
      setGitStatus(null);
    }
  }, [projectId, task.id, showGitStatus]);

  useEffect(() => {
    void loadGitStatus();
  }, [loadGitStatus, task.version, task.isolation_status, task.git_branch, task.humanReviewed]);

  if (!showPanel) return null;

  const isReady = task.isolation_status === 'ready';
  const isFailed = task.isolation_status === 'failed';
  const isRemoved = task.isolation_status === 'removed';
  const canManage = task.status === 'todo' || task.status === 'in_progress';

  const copyPath = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // ignore
    }
  };

  const handleMerge = async () => {
    if (!mergeTarget) return;

    const alreadyMerged = gitStatus?.merged_into.some(
      (m) => m.branch === mergeTarget && m.merged,
    );
    if (alreadyMerged) {
      toast.info(`此任務已合入 ${mergeTarget}，無需重複 merge`);
      return;
    }

    setMergeError('');
    setMergeConflicts([]);
    setLocalLoading('merge');
    try {
      await tasksApi.mergeBranch(projectId, task.id, mergeTarget);
      toast.success(`已成功 merge 到 ${mergeTarget}`);
      await onRefresh();
      await loadGitStatus();
    } catch (err) {
      const e = err as Error & { code?: string; conflicts?: string[] };
      if (e.code === 'ALREADY_MERGED') {
        toast.info(e.message);
      } else if (e.code === 'MERGE_CONFLICT') {
        toast.error('Merge 發生衝突，請到主 workspace 手動解決');
        setMergeConflicts(e.conflicts ?? []);
      } else {
        toast.error(e.message);
      }
      setMergeError(e.message);
    } finally {
      setLocalLoading('');
    }
  };

  const handleSwitchTemp = async () => {
    if (!gitStatus?.can_switch_temp_branch) return;
    if (
      gitStatus.worktree_dirty &&
      !confirm('worktree 有未提交改動，切換分支會攜帶這些改動。確定繼續？')
    ) {
      return;
    }
    if (
      task.status === 'in_progress' &&
      !confirm('任務處理中，切換臨時分支可能影響 Agent。確定繼續？')
    ) {
      return;
    }
    setLocalLoading('switch-temp');
    try {
      const updated = await tasksApi.switchTempBranch(projectId, task.id);
      setGitStatus(updated);
      toast.success(`已切換到臨時分支 ${updated.temp_branch ?? ''}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切換臨時分支失敗');
    } finally {
      setLocalLoading('');
    }
  };

  const handleRestoreTask = async () => {
    if (!gitStatus?.can_restore_task_branch) return;
    if (
      gitStatus.worktree_dirty &&
      !confirm('worktree 有未提交改動，切換分支會攜帶這些改動。確定繼續？')
    ) {
      return;
    }
    setLocalLoading('restore-task');
    try {
      const updated = await tasksApi.restoreTaskBranch(projectId, task.id);
      setGitStatus(updated);
      toast.success(`已恢復任務分支 ${updated.branch ?? ''}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '恢復任務分支失敗');
    } finally {
      setLocalLoading('');
    }
  };

  const loading = actionLoading || localLoading;

  const primaryMergeTarget =
    gitStatus?.merged_into_record ??
    gitStatus?.default_merge_target ??
    mergeTarget;
  const mergedBadge = primaryMergeTarget
    ? gitStatus?.merged_into.find((m) => m.branch === primaryMergeTarget)
    : undefined;
  const targetAlreadyMerged = gitStatus?.merged_into.some(
    (m) => m.branch === mergeTarget && m.merged,
  );

  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold mb-3">開發隔離</h3>
      <dl className="text-xs flex flex-col gap-2 mb-3">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground shrink-0">狀態</dt>
          <dd>
            {isReady && <span className="text-green-700">worktree 就緒</span>}
            {isFailed && <span className="text-red-600">建立失敗</span>}
            {isRemoved && <span className="text-muted-foreground">worktree 已刪除</span>}
            {task.isolation_status === 'none' && (
              <span className="text-muted-foreground">
                {task.use_isolation ? '尚未建立（交給 Agent 時建立）' : '未啟用'}
              </span>
            )}
          </dd>
        </div>
        {task.git_branch && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground shrink-0">Branch</dt>
            <dd className="font-mono text-right break-all">{task.git_branch}</dd>
          </div>
        )}
        {gitStatus?.worktree_exists && gitStatus.worktree_current_branch && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground shrink-0">Worktree 分支</dt>
            <dd className="font-mono text-right break-all">
              {gitStatus.worktree_current_branch}
              {gitStatus.on_temp_branch && (
                <span className="ml-1 text-amber-600 font-sans">（臨時）</span>
              )}
            </dd>
          </div>
        )}
        {gitStatus && primaryMergeTarget && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground shrink-0">合併狀態</dt>
            <dd>
              {mergedBadge?.merged ? (
                <span className="text-green-700">已合入 {mergedBadge.branch}</span>
              ) : (
                <span className="text-amber-600">尚未合入 {primaryMergeTarget}</span>
              )}
            </dd>
          </div>
        )}
        {task.merged_into && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground shrink-0">已 merge 至</dt>
            <dd className="font-mono text-right">{task.merged_into}</dd>
          </div>
        )}
        {task.worktree_path && !isRemoved && (
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">Worktree</dt>
            <dd className="font-mono text-[11px] break-all">{task.worktree_path}</dd>
          </div>
        )}
        {task.execution_path && (
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">Agent 工作目錄</dt>
            <dd className="font-mono text-[11px] break-all">{task.execution_path}</dd>
          </div>
        )}
        {task.isolation_base_sha && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground shrink-0">Base SHA</dt>
            <dd className="font-mono text-right truncate max-w-[160px]" title={task.isolation_base_sha}>
              {task.isolation_base_sha.slice(0, 12)}…
            </dd>
          </div>
        )}
      </dl>

      {isFailed && task.isolation_error && (
        <p className="text-xs text-red-600 mb-3 whitespace-pre-wrap">{task.isolation_error}</p>
      )}

      {task.status === 'done' && gitStatus && gitStatus.branch_exists && (
        <div className="mb-3 space-y-2">
          {gitStatus.worktree_dirty && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              worktree 有未提交改動，merge 只會包含已 commit 的內容。請在 worktree 內先 commit。
            </p>
          )}
          {gitStatus.workspace_dirty && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              主 workspace 有未提交變更，請先 commit 或 stash 後再 merge。
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label>Merge 目標分支</Label>
              <select
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono"
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                disabled={gitStatus.merge_targets.length === 0}
              >
                {gitStatus.merge_targets.length === 0 && (
                  <option value="">無可用分支</option>
                )}
                {gitStatus.merge_targets.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              onClick={() => void handleMerge()}
              disabled={
                !gitStatus.can_merge ||
                !mergeTarget ||
                loading === 'merge' ||
                targetAlreadyMerged
              }
            >
              {loading === 'merge'
                ? '合併中…'
                : targetAlreadyMerged
                  ? `已合入 ${mergeTarget}`
                  : `Merge 到 ${mergeTarget || '…'}`}
            </Button>
          </div>
          {targetAlreadyMerged && (
            <p className="text-xs text-muted-foreground">
              此分支已合入 {mergeTarget}，無需重複 merge。
            </p>
          )}
          {!gitStatus.can_merge && gitStatus.merge_block_reason && (
            <p className="text-xs text-muted-foreground">{gitStatus.merge_block_reason}</p>
          )}
          {mergeError && (
            <div className="text-xs text-red-600 space-y-1">
              <p>{mergeError}</p>
              {mergeConflicts.length > 0 && (
                <ul className="list-disc pl-4 font-mono">
                  {mergeConflicts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
              <p className="text-muted-foreground">請到主 workspace 手動解決衝突後再試。</p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {isReady && task.execution_path && (canManage || pendingReview) && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                onAction('open-cursor', () => tasksApi.openInCursor(projectId, task.id).then(() => task))
              }
              disabled={loading === 'open-cursor'}
            >
              用 Cursor 開啟
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => task.execution_path && copyPath(task.execution_path)}
            >
              複製工作目錄
            </Button>
          </>
        )}
        {isReady && gitStatus?.worktree_exists && (
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              切換臨時分支後，可在專案總覽將主 workspace 切到任務分支進行調試；恢復前請先在總覽切離任務分支。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!gitStatus.can_switch_temp_branch || loading === 'switch-temp'}
                onClick={() => void handleSwitchTemp()}
              >
                {loading === 'switch-temp' ? '切換中…' : '切換臨時分支'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!gitStatus.can_restore_task_branch || loading === 'restore-task'}
                onClick={() => void handleRestoreTask()}
              >
                {loading === 'restore-task' ? '恢復中…' : '恢復任務分支'}
              </Button>
            </div>
            {!gitStatus.can_switch_temp_branch &&
              !gitStatus.on_temp_branch &&
              gitStatus.switch_temp_block_reason && (
                <p className="text-xs text-muted-foreground">{gitStatus.switch_temp_block_reason}</p>
              )}
            {gitStatus.on_temp_branch &&
              !gitStatus.can_restore_task_branch &&
              gitStatus.restore_task_block_reason && (
                <p className="text-xs text-amber-700">{gitStatus.restore_task_block_reason}</p>
              )}
          </div>
        )}
        {(isFailed || (canManage && task.use_isolation && task.isolation_status === 'none')) && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onAction('retry-isolation', () => tasksApi.retryIsolation(projectId, task.id))
            }
            disabled={loading === 'retry-isolation'}
          >
            重試建立 worktree
          </Button>
        )}
        {isFailed && task.worktree_path && !isRemoved && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onAction('remove-worktree', () => tasksApi.removeWorktree(projectId, task.id))
            }
            disabled={loading === 'remove-worktree'}
          >
            清理失敗的 worktree
          </Button>
        )}
        {reviewed && gitStatus?.can_remove_worktree && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmRemoveWorktree(true)}
            disabled={loading === 'remove-worktree'}
          >
            刪除 worktree
          </Button>
        )}
        {reviewed && gitStatus && !gitStatus.can_remove_worktree && gitStatus.worktree_exists && (
          <p className="text-xs text-muted-foreground">{gitStatus.remove_worktree_block_reason}</p>
        )}
        {gitStatus?.can_restore_worktree && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmRestoreWorktree(true)}
            disabled={loading === 'restore-worktree'}
          >
            恢復 worktree
          </Button>
        )}
        {gitStatus && !gitStatus.can_restore_worktree && isRemoved && gitStatus.branch_exists && (
          <p className="text-xs text-muted-foreground">{gitStatus.restore_worktree_block_reason}</p>
        )}
        {reviewed && gitStatus?.can_delete_branch && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmDeleteBranch(true)}
            disabled={loading === 'delete-branch'}
          >
            刪除 branch
          </Button>
        )}
        {reviewed && gitStatus && gitStatus.branch_exists && !gitStatus.can_delete_branch && (
          <p className="text-xs text-muted-foreground">{gitStatus.delete_branch_block_reason}</p>
        )}
      </div>

      {isReady && canManage && (
        <p className="text-xs text-muted-foreground mt-3">
          請在 worktree 目錄開啟 Cursor 後再讓 Agent 認領，避免多任務同時改主目錄。
        </p>
      )}

      <Dialog open={confirmRemoveWorktree} onClose={() => setConfirmRemoveWorktree(false)} title="刪除 worktree">
        <p className="text-sm text-muted-foreground mb-4">
          將移除任務的隔離 worktree 目錄。未 commit 的改動會一併丟失，請確認已 merge 或 commit。
        </p>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={() => setConfirmRemoveWorktree(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmRemoveWorktree(false);
              onAction('remove-worktree', () => tasksApi.removeWorktree(projectId, task.id));
            }}
            disabled={loading === 'remove-worktree'}
          >
            確認刪除
          </Button>
        </div>
      </Dialog>

      <Dialog open={confirmDeleteBranch} onClose={() => setConfirmDeleteBranch(false)} title="刪除 branch">
        <p className="text-sm text-muted-foreground mb-4">
          將刪除本地分支 <code className="font-mono">{task.git_branch}</code>。此操作不可復原。
        </p>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={() => setConfirmDeleteBranch(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmDeleteBranch(false);
              onAction('delete-branch', () => tasksApi.deleteBranch(projectId, task.id));
            }}
            disabled={loading === 'delete-branch'}
          >
            確認刪除
          </Button>
        </div>
      </Dialog>

      <Dialog open={confirmRestoreWorktree} onClose={() => setConfirmRestoreWorktree(false)} title="恢復 worktree">
        <p className="text-sm text-muted-foreground mb-4">
          將從分支 <code className="font-mono">{task.git_branch}</code> 重新建立隔離 worktree。
          僅能恢復<strong>已 commit</strong> 的內容；刪除前未 commit 的改動無法找回。
        </p>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={() => setConfirmRestoreWorktree(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              setConfirmRestoreWorktree(false);
              onAction('restore-worktree', () => tasksApi.restoreWorktree(projectId, task.id));
            }}
            disabled={loading === 'restore-worktree'}
          >
            確認恢復
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function isPendingReview(task: Task): boolean {
  return task.status === 'done' && !task.humanReviewed;
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
