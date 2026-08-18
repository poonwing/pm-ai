import { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { projectsApi, dialogsApi, folderNameFromPath, Project } from '../lib/api';
import { Button, Card, Dialog, Input, Label, Textarea } from '../components/ui';
import { formatRelativeTime } from '../lib/utils';

interface OutletContext {
  projects: Project[];
  reloadProjects: () => void;
}

export function ProjectListPage() {
  const navigate = useNavigate();
  const { projects = [], reloadProjects } = useOutletContext<OutletContext>();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim() || !workspacePath.trim()) {
      setError('請填寫專案名稱和 workspace 路徑');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const project = await projectsApi.create({
        name: name.trim(),
        workspace_path: workspacePath.trim(),
        description: description.trim() || undefined,
      });
      reloadProjects();
      setShowCreate(false);
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '建立失敗');
    } finally {
      setLoading(false);
    }
  };

  const handlePickFolder = async () => {
    setPicking(true);
    setError('');
    try {
      const result = await dialogsApi.pickFolder(workspacePath.trim() || undefined);
      if (result.cancelled || !result.path) return;
      setWorkspacePath(result.path);
      setName((current) => current.trim() || folderNameFromPath(result.path!));
    } catch (err) {
      setError(err instanceof Error ? err.message : '選擇資料夾失敗');
    } finally {
      setPicking(false);
    }
  };

  if (projects.length === 0 && !showCreate) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <h1 className="text-2xl font-semibold">還沒有專案</h1>
        <p className="text-muted-foreground max-w-sm">
          選一個本機資料夾當 workspace，再把任務交給你自己的 AI Agent。
        </p>
        <Button onClick={() => setShowCreate(true)}>建立專案</Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">我的專案</h1>
        <Button onClick={() => setShowCreate(true)}>建立專案</Button>
      </div>

      <div className="flex flex-col gap-3">
        {projects.map((project) => (
          <Card
            key={project.id}
            className="cursor-pointer hover:bg-accent/30 transition-colors"
            onClick={() => navigate(`/projects/${project.id}`)}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-medium">{project.name}</h2>
                <p className="text-xs text-muted-foreground mt-1 font-mono">
                  {project.workspacePath}
                </p>
              </div>
              <div className="text-right">
                {project.bindingStatus === 'missing' ? (
                  <span className="text-xs text-red-500">資料夾遺失</span>
                ) : project.archived ? (
                  <span className="text-xs text-muted-foreground">已封存</span>
                ) : (
                  project.lastOpenedAt && (
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(project.lastOpenedAt)}
                    </span>
                  )
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="建立專案">
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="name">專案名稱</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：pm-ai"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="path">Workspace 資料夾</Label>
            <div className="mt-1 flex gap-2">
              <Input
                id="path"
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="選擇或貼上本機資料夾路徑"
                className="font-mono text-xs"
              />
              <Button type="button" variant="outline" onClick={handlePickFolder} disabled={picking}>
                {picking ? '選擇中…' : '選擇資料夾'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              會跳出系統選夾視窗；也可直接貼上路徑。
            </p>
          </div>
          <div>
            <Label htmlFor="desc">說明（可選）</Label>
            <Textarea
              id="desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1"
              rows={2}
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={loading}>
              {loading ? '建立中…' : '建立'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
