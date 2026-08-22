import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { tasksApi, projectsApi, Task, Project } from '../lib/api';
import { Button, Badge, Input, Textarea, Label, Dialog } from '../components/ui';
import { formatRelativeTime, statusLabel, statusColor, statusDotColor } from '../lib/utils';
import { TASK_STATUSES, TaskStatus } from '@shared/schemas';

type ViewMode = 'board' | 'list';

const emptyCreateForm = () => ({
  title: '',
  goal: '',
  acceptance_criteria: '',
  constraints: '',
  use_isolation: true,
});

export function TasksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [view, setView] = useState<ViewMode>('board');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'needs_attention'>('all');
  const [showCancelled, setShowCancelled] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    const data = await tasksApi.list(projectId);
    setTasks(data);
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!projectId) return;
    projectsApi.get(projectId).then(setProject).catch(() => setProject(null));
  }, [projectId]);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowCreateDialog(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const hasInProgress = tasks.some((t) => t.status === 'in_progress');
    const interval = setInterval(load, hasInProgress ? 3000 : 8000);
    return () => clearInterval(interval);
  }, [load, tasks]);

  const openCreateDialog = async () => {
    setCreateError('');
    setShowCreateDialog(true);
    if (!projectId) return;
    try {
      const p = await projectsApi.get(projectId);
      setProject(p);
      setCreateForm({
        ...emptyCreateForm(),
        use_isolation: !!p.gitRoot,
      });
    } catch {
      setProject(null);
      setCreateForm(emptyCreateForm());
    }
  };

  const handleCreate = async () => {
    if (!projectId) return;
    if (!createForm.title.trim()) {
      setCreateError('請填寫任務標題');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const task = await tasksApi.create(projectId, {
        title: createForm.title.trim(),
        goal: createForm.goal.trim() || undefined,
        acceptance_criteria: createForm.acceptance_criteria.trim() || undefined,
        constraints: createForm.constraints.trim() || undefined,
        use_isolation: project?.gitRoot ? createForm.use_isolation : false,
      });
      setShowCreateDialog(false);
      navigate(`/projects/${projectId}/tasks/${task.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '建立失敗');
    } finally {
      setCreating(false);
    }
  };

  const filtered = tasks.filter((t) => {
    if (!showCancelled && t.status === 'cancelled') return false;
    if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'needs_attention') {
      return (
        t.status === 'draft' ||
        (t.status === 'done' && !t.humanReviewed)
      );
    }
    return true;
  });

  const columns: TaskStatus[] = showCancelled
    ? [...TASK_STATUSES]
    : TASK_STATUSES.filter((s) => s !== 'cancelled');

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex h-9 w-max min-w-max shrink-0 overflow-hidden rounded-md border border-border">
            <button
              type="button"
              className={`h-9 min-w-max shrink-0 whitespace-nowrap px-3 text-sm leading-9 ${view === 'board' ? 'bg-accent font-medium' : 'hover:bg-accent/50'}`}
              onClick={() => setView('board')}
            >
              看板
            </button>
            <button
              type="button"
              className={`h-9 min-w-max shrink-0 whitespace-nowrap border-l border-border px-3 text-sm leading-9 ${view === 'list' ? 'bg-accent font-medium' : 'hover:bg-accent/50'}`}
              onClick={() => setView('list')}
            >
              列表
            </button>
          </div>
          <select
            className="text-sm border border-border rounded-md px-2 py-1.5 bg-background"
            value={filter}
            onChange={(e) => setFilter(e.target.value as 'all' | 'needs_attention')}
          >
            <option value="all">全部</option>
            <option value="needs_attention">等人的</option>
          </select>
          <Input
            placeholder="搜尋標題"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-40"
          />
        </div>
        <Button onClick={openCreateDialog}>+ 新增任務</Button>
      </div>

      {view === 'board' ? (
        <div className="flex gap-3 overflow-x-auto pb-4 flex-1">
          {columns.map((status) => {
            const colTasks = filtered.filter((t) => t.status === status);
            return (
              <div key={status} className="flex-shrink-0 w-56 flex flex-col gap-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {statusLabel(status)} ({colTasks.length})
                  </span>
                </div>
                <div className="flex flex-col gap-2 min-h-[100px]">
                  {colTasks.map((task) => (
                    <TaskCard
                      key={task.uid}
                      task={task}
                      projectId={projectId!}
                    />
                  ))}
                  {colTasks.length === 0 && (
                    <div className="text-xs text-muted-foreground text-center py-4">
                      沒有{statusLabel(status)}任務
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {!showCancelled && (
            <button
              className="text-xs text-muted-foreground self-start mt-6 hover:underline"
              onClick={() => setShowCancelled(true)}
            >
              顯示已取消
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-4">狀態</th>
                <th className="pb-2 pr-4">ID</th>
                <th className="pb-2 pr-4">標題</th>
                <th className="pb-2 pr-4">指派</th>
                <th className="pb-2 pr-4">審查</th>
                <th className="pb-2">更新</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => (
                <tr
                  key={task.uid}
                  className="border-b border-border hover:bg-accent/30 cursor-pointer"
                  onClick={() => navigate(`/projects/${projectId}/tasks/${task.id}`)}
                >
                  <td className="py-2 pr-4">
                    <Badge className={statusColor(task.status, task.humanReviewed)}>
                      {task.status === 'done' && !task.humanReviewed
                        ? '待你驗收'
                        : statusLabel(task.status)}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{task.id}</td>
                  <td className="py-2 pr-4">{task.title}</td>
                  <td className="py-2 pr-4 text-xs">
                    {task.assignee_name
                      ? `@${task.assignee_name}${task.queue_order != null ? ` #${task.queue_order}` : ''}`
                      : '—'}
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    {task.review
                      ? `${task.review.reviewer_type}/${task.review.status}`
                      : '—'}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {formatRelativeTime(task.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={showCreateDialog} onClose={() => setShowCreateDialog(false)} title="新增任務">
        <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
          <div>
            <Label htmlFor="create-title">標題 *</Label>
            <Input
              id="create-title"
              value={createForm.title}
              onChange={(e) => setCreateForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="任務標題"
              className="mt-1"
              autoFocus
            />
          </div>

          <section className="rounded-md border border-blue-200 bg-blue-50/50 p-3">
            <h3 className="text-sm font-semibold text-blue-900 mb-2">Git 隔離（worktree）</h3>
            <label
              className={`flex items-start gap-2 text-sm ${project?.gitRoot ? 'cursor-pointer' : 'cursor-not-allowed'}`}
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={project?.gitRoot ? createForm.use_isolation : false}
                disabled={!project?.gitRoot}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, use_isolation: e.target.checked }))
                }
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

          <div>
            <Label htmlFor="create-goal">目標</Label>
            <Textarea
              id="create-goal"
              value={createForm.goal}
              onChange={(e) => setCreateForm((f) => ({ ...f, goal: e.target.value }))}
              placeholder="想達成什麼"
              rows={2}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="create-ac">驗收標準</Label>
            <Textarea
              id="create-ac"
              value={createForm.acceptance_criteria}
              onChange={(e) => setCreateForm((f) => ({ ...f, acceptance_criteria: e.target.value }))}
              placeholder="交給 Agent 前必填；可先留空，之後在詳情頁補上"
              rows={3}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="create-constraints">約束與範圍</Label>
            <Textarea
              id="create-constraints"
              value={createForm.constraints}
              onChange={(e) => setCreateForm((f) => ({ ...f, constraints: e.target.value }))}
              placeholder="不要動哪些檔案、技術限制等"
              rows={2}
              className="mt-1"
            />
          </div>
          {createError && (
            <p className="text-sm text-red-600">{createError}</p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={creating || !createForm.title.trim()}>
              {creating ? '建立中…' : '確認新建'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function reviewBadge(task: Task): string | null {
  if (task.status !== 'done') return null;
  const r = task.review;
  if (r?.required === false || r?.reviewer_type === 'none' || r?.status === 'approved') {
    return r?.status === 'approved' ? '審查通過' : null;
  }
  if (!r || r.reviewer_type === 'human') {
    return task.humanReviewed ? null : '待人驗';
  }
  if (r.reviewer_type === 'orchestrator') return '待協調者复查';
  if (r.reviewer_type === 'agent') return `待 AI 复查`;
  if (r.status === 'pending') return '待審查';
  return null;
}

function TaskCard({ task, projectId }: { task: Task; projectId: string }) {
  const label =
    task.status === 'done' && !task.humanReviewed && (!task.review || task.review.reviewer_type === 'human')
      ? '待你驗收'
      : statusLabel(task.status);
  const rev = reviewBadge(task);

  return (
    <Link
      to={`/projects/${projectId}/tasks/${task.id}`}
      className="block p-3 rounded-md border border-border bg-card hover:bg-accent/30 transition-colors"
    >
      <div className="flex items-start gap-2">
        <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${statusDotColor(task.status)}`} />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{task.title}</p>
          <p className="text-xs text-muted-foreground mt-1">{task.id}</p>
          {(task.assignee_name || task.queue_order != null) && (
            <p className="text-xs text-blue-700 mt-1 truncate">
              {task.assignee_name ? `@${task.assignee_name}` : ''}
              {task.queue_order != null ? ` #${task.queue_order}` : ''}
            </p>
          )}
          <div className="flex items-center justify-between mt-2 gap-1 flex-wrap">
            <Badge className={statusColor(task.status, task.humanReviewed)}>{label}</Badge>
            {rev && <Badge className="bg-violet-100 text-violet-800">{rev}</Badge>}
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(task.updatedAt)}
            </span>
          </div>
          {task.status === 'in_progress' && task.claimedBy && (
            <p className="text-xs text-amber-600 mt-1">{task.claimedBy}</p>
          )}
        </div>
      </div>
    </Link>
  );
}

