import { useEffect, useState } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import { projectsApi, configApi, dialogsApi, Project } from '../lib/api';
import { Button, Input, Label, Textarea } from '../components/ui';

interface OutletContext {
  reloadProjects: () => void;
}

export function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { reloadProjects } = useOutletContext<OutletContext>();
  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [newPath, setNewPath] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    projectsApi.get(projectId).then((p) => {
      setProject(p);
      setName(p.name);
      setDescription(p.description);
      setNewPath(p.workspacePath);
    });
  }, [projectId]);

  const save = async () => {
    if (!projectId) return;
    try {
      const updated = await projectsApi.update(projectId, { name, description });
      setProject(updated);
      reloadProjects();
      setMessage('已儲存');
      setTimeout(() => setMessage(''), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗');
    }
  };

  const relocate = async () => {
    if (!projectId) return;
    try {
      const updated = await projectsApi.relocate(projectId, newPath.trim());
      setProject(updated);
      reloadProjects();
      setMessage('已重新定位 workspace');
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新定位失敗');
    }
  };

  const archive = async () => {
    if (!projectId || !confirm('確定要封存此專案？')) return;
    await projectsApi.update(projectId, { archived: true });
    reloadProjects();
    setMessage('已封存');
  };

  if (!project) return <div className="text-muted-foreground">載入中…</div>;

  return (
    <div className="max-w-lg flex flex-col gap-6">
      <h1 className="text-xl font-semibold">專案設定</h1>

      {project.bindingStatus === 'missing' && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          Workspace 找不到。請在下方重新定位資料夾。
        </div>
      )}

      {message && <p className="text-sm text-green-600">{message}</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex flex-col gap-4">
        <div>
          <Label htmlFor="name">專案名稱</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label htmlFor="desc">說明</Label>
          <Textarea
            id="desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1"
            rows={2}
          />
        </div>
        <Button onClick={save}>儲存</Button>
      </div>

      <hr className="border-border" />

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Workspace 路徑</h2>
        <div className="flex gap-2">
          <Input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            disabled={picking}
            onClick={async () => {
              setPicking(true);
              setError('');
              try {
                const result = await dialogsApi.pickFolder(newPath.trim() || undefined);
                if (!result.cancelled && result.path) setNewPath(result.path);
              } catch (err) {
                setError(err instanceof Error ? err.message : '選擇資料夾失敗');
              } finally {
                setPicking(false);
              }
            }}
          >
            {picking ? '選擇中…' : '選擇資料夾'}
          </Button>
        </div>
        <Button variant="outline" onClick={relocate}>
          重新定位資料夾
        </Button>
      </div>

      <hr className="border-border" />

      <div>
        <Button variant="destructive" onClick={archive}>
          封存專案
        </Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [config, setConfig] = useState<{ baseUrl: string; port: number; token: string } | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    configApi.get().then(setConfig);
  }, []);

  const regenerate = async () => {
    const { token } = await configApi.regenerateToken();
    setConfig((c) => (c ? { ...c, token } : c));
    setMessage('Token 已重新產生');
  };

  const copyToken = () => {
    if (config?.token) {
      navigator.clipboard.writeText(config.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="max-w-lg flex flex-col gap-6">
      <h1 className="text-xl font-semibold">設定</h1>

      {config && (
        <>
          <div className="flex flex-col gap-3">
            <div>
              <Label>API 位址</Label>
              <p className="text-sm font-mono mt-1">{config.baseUrl}</p>
            </div>
            <div>
              <Label>API Token（給 Agent 用）</Label>
              <div className="flex gap-2 mt-1">
                <Input value={config.token} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="sm" onClick={copyToken}>
                  {copied ? '已複製' : '複製'}
                </Button>
              </div>
            </div>
            <Button variant="outline" onClick={regenerate}>
              重新產生 Token
            </Button>
            {message && <p className="text-sm text-green-600">{message}</p>}
          </div>

          <div className="text-sm text-muted-foreground">
            <p>Token 儲存於 <code className="text-xs">%APPDATA%/pm-ai/config.json</code></p>
            <p className="mt-2">Agent 請在請求 Header 加入：</p>
            <pre className="mt-1 bg-muted rounded p-2 text-xs overflow-x-auto">
              {`Authorization: Bearer ${config.token.slice(0, 8)}…\nX-PM-AI-Actor: agent`}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
