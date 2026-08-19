import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { projectsApi, Dashboard, Project } from '../lib/api';
import { Button, Card, Badge } from '../components/ui';
import { formatRelativeTime, statusLabel, statusColor } from '../lib/utils';

export function ProjectDashboardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [p, d] = await Promise.all([
        projectsApi.get(projectId),
        projectsApi.dashboard(projectId),
      ]);
      setProject(p);
      setDashboard(d);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入失敗');
    }
  }, [projectId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [load]);

  if (error) {
    return <div className="text-red-500">{error}</div>;
  }

  if (!project || !dashboard) {
    return <div className="text-muted-foreground">載入中…</div>;
  }

  const needsAttention = [
    ...dashboard.pendingReview.map((t) => ({ ...t, reason: '待你驗收' })),
    ...dashboard.drafts.filter((t) => !t.title),
  ];

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-6">
      {project.bindingStatus === 'missing' && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          Workspace 找不到：{project.workspacePath}。請到
          <Link to={`/projects/${projectId}/settings`} className="underline mx-1">
            專案設定
          </Link>
          重新定位。
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <p className="text-xs text-muted-foreground font-mono mt-1">{project.workspacePath}</p>
        </div>
        <Link to={`/projects/${projectId}/tasks?new=1`}>
          <Button>新增任務</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: '草稿', value: dashboard.stats.draft },
          { label: '待處理', value: dashboard.stats.todo },
          { label: '處理中', value: dashboard.stats.inProgress },
          { label: '待驗收', value: dashboard.stats.pendingReview },
        ].map((s) => (
          <Card key={s.label} className="text-center py-3">
            <div className="text-2xl font-semibold">{s.value}</div>
            <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
          </Card>
        ))}
      </div>

      {needsAttention.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-3 border-l-4 border-blue-400 pl-2">等人處理</h2>
          <div className="flex flex-col gap-2">
            {dashboard.pendingReview.map((task) => (
              <Link
                key={task.uid}
                to={`/projects/${projectId}/tasks/${task.id}`}
                className="flex items-center justify-between p-3 rounded-md border border-border hover:bg-accent/30 transition-colors border-l-4 border-l-blue-400"
              >
                <span className="text-sm font-medium">{task.title}</span>
                <Badge className="text-amber-600 border-amber-300 bg-amber-50">待你驗收</Badge>
              </Link>
            ))}
            {dashboard.drafts.map((task) => (
              <Link
                key={task.uid}
                to={`/projects/${projectId}/tasks/${task.id}`}
                className="flex items-center justify-between p-3 rounded-md border border-border hover:bg-accent/30 transition-colors"
              >
                <span className="text-sm">{task.title || '（無標題）'}</span>
                <Badge className={statusColor('draft')}>草稿未交</Badge>
              </Link>
            ))}
          </div>
        </section>
      )}

      {dashboard.inProgress.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-3">進行中</h2>
          <div className="flex flex-col gap-2">
            {dashboard.inProgress.map((task) => (
              <Link
                key={task.uid}
                to={`/projects/${projectId}/tasks/${task.id}`}
                className="flex items-center justify-between p-3 rounded-md border border-border hover:bg-accent/30 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 pulse-dot" />
                  <span className="text-sm font-medium">{task.title}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {task.claimedBy ?? 'Agent'} · {formatRelativeTime(task.updatedAt)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {dashboard.recentActivities.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-3">最近狀態變化</h2>
          <div className="flex flex-col gap-1">
            {dashboard.recentActivities.map((a) => (
              <div key={a.id} className="text-xs text-muted-foreground py-1">
                {formatRelativeTime(a.at)} · {a.actorName ?? a.actor} · {a.taskId}
                {a.fromStatus && a.toStatus && (
                  <> · {statusLabel(a.fromStatus as import('@shared/schemas').TaskStatus)} → {statusLabel(a.toStatus as import('@shared/schemas').TaskStatus)}</>
                )}
                {a.summary && <> · {a.summary}</>}
              </div>
            ))}
          </div>
        </section>
      )}

      {dashboard.stats.total === 0 && (
        <Card className="text-center py-8">
          <p className="text-muted-foreground mb-4">尚無任務。先寫成草稿，確認驗收標準後再交給 Agent。</p>
          <Link to={`/projects/${projectId}/tasks?new=1`}>
            <Button>新增任務</Button>
          </Link>
        </Card>
      )}
    </div>
  );
}
