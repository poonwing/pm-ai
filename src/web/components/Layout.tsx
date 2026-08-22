import { useEffect, useState, useCallback } from 'react';
import { Link, NavLink, Outlet, useParams, useNavigate } from 'react-router-dom';
import { projectsApi, activityApi, Project } from '../lib/api';
import { Button } from './ui';
import { WorkspaceBranchSwitcher } from './WorkspaceBranchSwitcher';
import { formatRelativeTime } from '../lib/utils';

export function Layout() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [apiStatus, setApiStatus] = useState<'idle' | 'active' | 'processing' | 'error'>('idle');
  const [lastActivity, setLastActivity] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const data = await projectsApi.list();
      setProjects(data);
    } catch {
      setApiStatus('error');
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    const check = async () => {
      try {
        const { activity } = await activityApi.recent();
        if (activity) {
          setLastActivity(activity.at);
          const age = Date.now() - new Date(activity.at).getTime();
          if (age < 10000) setApiStatus('active');
          else setApiStatus('idle');
        }
      } catch {
        setApiStatus('error');
      }
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

  const currentProject = projects.find((p) => p.id === projectId);

  const statusDot = {
    idle: 'bg-zinc-400',
    active: 'bg-blue-500',
    processing: 'bg-amber-500 pulse-dot',
    error: 'bg-red-500',
  }[apiStatus];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border px-4 h-12 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <Link to="/" className="font-semibold text-sm hover:opacity-70">
            PM-AI
          </Link>
          {projectId && currentProject && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">/</span>
              <select
                className="text-sm bg-transparent border-none focus:outline-none cursor-pointer"
                value={projectId}
                onChange={(e) => navigate(`/projects/${e.target.value}`)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {projectId && currentProject?.gitRoot && (
            <WorkspaceBranchSwitcher projectId={projectId} />
          )}
          <div
            className="flex items-center gap-1.5"
            title={lastActivity ? `最後活動：${formatRelativeTime(lastActivity)}` : '無近期活動'}
          >
            <span className={`w-2 h-2 rounded-full ${statusDot}`} />
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {apiStatus === 'error' ? 'API 離線' : apiStatus === 'active' ? 'Agent 活躍' : '本機 · 未登入'}
            </span>
          </div>
          <Link to="/settings">
            <Button variant="ghost" size="sm">
              設定
            </Button>
          </Link>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {projectId && (
          <nav className="w-44 shrink-0 border-r border-border p-3 flex flex-col gap-1">
            <NavLink
              to={`/projects/${projectId}`}
              end
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'
                }`
              }
            >
              總覽
            </NavLink>
            <NavLink
              to={`/projects/${projectId}/tasks`}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'
                }`
              }
            >
              任務
            </NavLink>
            <NavLink
              to={`/projects/${projectId}/agents`}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'
                }`
              }
            >
              AI 員工
            </NavLink>
            <NavLink
              to={`/projects/${projectId}/auto`}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'
                }`
              }
            >
              Auto
            </NavLink>
            <NavLink
              to={`/projects/${projectId}/settings`}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'
                }`
              }
            >
              專案設定
            </NavLink>
          </nav>
        )}
        <main className="flex-1 overflow-auto p-6">
          <Outlet context={{ projects, reloadProjects: loadProjects }} />
        </main>
      </div>
    </div>
  );
}
