import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { tasksApi, Task } from '../lib/api';
import { Button, Badge, Input } from '../components/ui';
import { formatRelativeTime, statusLabel, statusColor, statusDotColor } from '../lib/utils';
import { TASK_STATUSES, TaskStatus } from '@shared/schemas';

type ViewMode = 'board' | 'list';

export function TasksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<ViewMode>('board');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'needs_attention'>('all');
  const [showCancelled, setShowCancelled] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    const data = await tasksApi.list(projectId);
    setTasks(data);
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const hasInProgress = tasks.some((t) => t.status === 'in_progress');
    const interval = setInterval(load, hasInProgress ? 3000 : 8000);
    return () => clearInterval(interval);
  }, [load, tasks]);

  const handleCreate = async () => {
    if (!projectId) return;
    setCreating(true);
    try {
      const task = await tasksApi.create(projectId, { title: '新任務' });
      navigate(`/projects/${projectId}/tasks/${task.id}`);
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
          <div className="flex rounded-md border border-border overflow-hidden">
            <button
              className={`px-3 py-1.5 text-sm ${view === 'board' ? 'bg-accent font-medium' : 'hover:bg-accent/50'}`}
              onClick={() => setView('board')}
            >
              看板
            </button>
            <button
              className={`px-3 py-1.5 text-sm ${view === 'list' ? 'bg-accent font-medium' : 'hover:bg-accent/50'}`}
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
        <Button onClick={handleCreate} disabled={creating}>
          {creating ? '建立中…' : '+ 新增任務'}
        </Button>
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
                  <td className="py-2 text-xs text-muted-foreground">
                    {formatRelativeTime(task.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, projectId }: { task: Task; projectId: string }) {
  const label =
    task.status === 'done' && !task.humanReviewed ? '待你驗收' : statusLabel(task.status);

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
          <div className="flex items-center justify-between mt-2">
            <Badge className={statusColor(task.status, task.humanReviewed)}>{label}</Badge>
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
