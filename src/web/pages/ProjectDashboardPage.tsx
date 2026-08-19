import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { projectsApi, Dashboard, Project, WorkspaceGitStatus } from '../lib/api';
import { Button, Card, Badge, Label } from '../components/ui';
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

      {project.gitRoot && projectId && (
        <WorkspaceBranchPanel projectId={projectId} gitRoot={project.gitRoot} />
      )}

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

function WorkspaceBranchPanel({
  projectId,
  gitRoot,
}: {
  projectId: string;
  gitRoot: string;
}) {
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadGit = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const status = await projectsApi.getGit(projectId);
      setGitStatus(status);
      const current = status.current_branch ?? '';
      setSelectedBranch((prev) => {
        if (prev && status.branches.some((b) => b.name === prev && b.selectable)) return prev;
        const firstSelectable = status.branches.find((b) => b.selectable)?.name ?? current;
        return firstSelectable || current;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入 git 狀態失敗');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadGit();
  }, [loadGit]);

  const handleCheckout = async () => {
    if (!selectedBranch || !gitStatus) return;
    const target = gitStatus.branches.find((b) => b.name === selectedBranch);
    if (!target?.selectable) return;
    if (target.current) {
      setMessage('已在該分支上');
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    if (
      gitStatus.dirty &&
      !confirm('主 workspace 有未提交變更，切換分支可能失敗或造成衝突。確定要切換？')
    ) {
      return;
    }

    setSwitching(true);
    setError('');
    setMessage('');
    try {
      const updated = await projectsApi.checkoutBranch(projectId, selectedBranch);
      setGitStatus(updated);
      setSelectedBranch(updated.current_branch ?? selectedBranch);
      setMessage(`已切換到 ${updated.current_branch ?? selectedBranch}`);
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '切換分支失敗');
    } finally {
      setSwitching(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">載入 git 分支…</p>
      </Card>
    );
  }

  if (!gitStatus?.available) {
    return null;
  }

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">本機分支</h2>
          <p className="text-xs text-muted-foreground mt-1">
            切換主 workspace 的 git 分支以便本機調試（不影響任務 worktree）。
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 min-w-[200px] flex-1">
            <Label htmlFor="branch-select">目前：{gitStatus.current_branch ?? '（未知）'}</Label>
            <select
              id="branch-select"
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm font-mono"
            >
              {gitStatus.branches.map((b) => (
                <option key={b.name} value={b.name} disabled={!b.selectable}>
                  {b.name}
                  {b.current ? ' (目前)' : ''}
                  {b.worktree_path ? ' — 已在 worktree' : ''}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="outline"
            disabled={switching || !selectedBranch}
            onClick={() => void handleCheckout()}
          >
            {switching ? '切換中…' : '切換分支'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void loadGit()}>
            重新整理
          </Button>
        </div>

        {gitStatus.dirty && (
          <p className="text-xs text-amber-700">主 workspace 有未提交變更</p>
        )}
        {message && <p className="text-xs text-green-600">{message}</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <p className="text-[11px] text-muted-foreground font-mono break-all">{gitRoot}</p>
      </div>
    </Card>
  );
}
