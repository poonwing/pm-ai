import { useCallback, useEffect, useState } from 'react';
import { projectsApi, WorkspaceGitStatus } from '../lib/api';
import { Button, Dialog, Label } from './ui';

export function WorkspaceBranchSwitcher({ projectId }: { projectId: string }) {
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadGit = useCallback(async () => {
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
      setGitStatus(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void loadGit();
    const interval = setInterval(() => void loadGit(), 30000);
    return () => clearInterval(interval);
  }, [loadGit]);

  useEffect(() => {
    if (open) {
      setLoading(true);
      void loadGit();
    }
  }, [open, loadGit]);

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
      setTimeout(() => {
        setOpen(false);
        setMessage('');
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : '切換分支失敗');
    } finally {
      setSwitching(false);
    }
  };

  if (!loading && !gitStatus?.available) {
    return null;
  }

  const currentBranch = gitStatus?.current_branch ?? '…';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-mono hover:bg-accent/50 transition-colors max-w-[180px]"
        title="切換 workspace 分支"
      >
        {gitStatus?.dirty && (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
        )}
        <span className="truncate">{loading && !gitStatus ? '…' : currentBranch}</span>
        <span className="text-muted-foreground shrink-0">▾</span>
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="切換 workspace 分支">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            切換主 workspace 的 git 分支以便本機調試（不影響任務 worktree）。
          </p>

          {loading && !gitStatus ? (
            <p className="text-sm text-muted-foreground">載入 git 分支…</p>
          ) : gitStatus ? (
            <>
              <div>
                <Label htmlFor="header-branch-select">
                  目前：{gitStatus.current_branch ?? '（未知）'}
                </Label>
                <select
                  id="header-branch-select"
                  value={selectedBranch}
                  onChange={(e) => setSelectedBranch(e.target.value)}
                  className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-sm font-mono"
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

              {gitStatus.dirty && (
                <p className="text-xs text-amber-700">主 workspace 有未提交變更</p>
              )}
              {message && <p className="text-xs text-green-600">{message}</p>}
              {error && <p className="text-xs text-red-600">{error}</p>}

              {gitStatus.git_root && (
                <p className="text-[11px] text-muted-foreground font-mono break-all">
                  {gitStatus.git_root}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => void loadGit()}>
                  重新整理
                </Button>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button
                  disabled={switching || !selectedBranch}
                  onClick={() => void handleCheckout()}
                >
                  {switching ? '切換中…' : '切換分支'}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-red-600">{error || '無法載入 git 狀態'}</p>
          )}
        </div>
      </Dialog>
    </>
  );
}
