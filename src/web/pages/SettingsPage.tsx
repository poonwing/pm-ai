import { useEffect, useState } from 'react';
import { useParams, useOutletContext, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { projectsApi, configApi, dialogsApi, Project } from '../lib/api';
import { Button, Input, Label, Textarea, Dialog } from '../components/ui';

interface OutletContext {
  reloadProjects: () => void;
}

export function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { reloadProjects } = useOutletContext<OutletContext>();
  const [project, setProject] = useState<Project | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [forceDelete, setForceDelete] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [newPath, setNewPath] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const [skillLoading, setSkillLoading] = useState(false);
  const [initLoading, setInitLoading] = useState(false);
  const [previewCommand, setPreviewCommand] = useState('npm run dev');
  const [previewInstallCommand, setPreviewInstallCommand] = useState('npm install');
  const [previewInstallIfNeeded, setPreviewInstallIfNeeded] = useState(true);
  const [previewWorkdir, setPreviewWorkdir] = useState('');

  useEffect(() => {
    if (!projectId) return;
    projectsApi.get(projectId).then((p) => {
      setProject(p);
      setName(p.name);
      setDescription(p.description);
      setNewPath(p.workspacePath);
      setPreviewCommand(p.previewCommand ?? 'npm run dev');
      setPreviewInstallCommand(p.previewInstallCommand ?? 'npm install');
      setPreviewInstallIfNeeded(p.previewInstallIfNeeded ?? true);
      setPreviewWorkdir(p.previewWorkdir ?? '');
    });
  }, [projectId]);

  const save = async () => {
    if (!projectId) return;
    try {
      const updated = await projectsApi.update(projectId, {
        name,
        description,
        preview_command: previewCommand.trim(),
        preview_install_command: previewInstallCommand.trim(),
        preview_install_if_needed: previewInstallIfNeeded,
        preview_workdir: previewWorkdir.trim(),
      });
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
        <p className="text-xs text-muted-foreground">
          Git 根目錄：
          {project.gitRoot ? (
            <code className="block font-mono mt-1 break-all">{project.gitRoot}</code>
          ) : (
            <span className="text-amber-600"> 未偵測到（worktree 隔離不可用）</span>
          )}
        </p>
      </div>

      <hr className="border-border" />

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">調試預覽</h2>
        <p className="text-xs text-muted-foreground">
          任務詳情可一鍵在 worktree（或主 workspace）啟動開發服務。每個任務分配獨立端口（從 7500 起）。
          命令支援 <code className="font-mono">{'{port}'}</code> 占位符；也會注入環境變數{' '}
          <code className="font-mono">PORT</code>、<code className="font-mono">HOST=127.0.0.1</code>。
        </p>
        <div>
          <Label htmlFor="preview-workdir">工作子目錄（可選）</Label>
          <Input
            id="preview-workdir"
            value={previewWorkdir}
            onChange={(e) => setPreviewWorkdir(e.target.value)}
            className="mt-1 font-mono text-xs"
            placeholder="frontend（相對於 worktree / workspace 根目錄）"
          />
          <p className="text-xs text-muted-foreground mt-1">
            若 package.json 不在根目錄（例如 monorepo 的 frontend/），請填寫子目錄名。留空時會嘗試自動偵測。
          </p>
        </div>
        <div>
          <Label htmlFor="preview-command">啟動命令</Label>
          <Input
            id="preview-command"
            value={previewCommand}
            onChange={(e) => setPreviewCommand(e.target.value)}
            className="mt-1 font-mono text-xs"
            placeholder="npm run dev"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Vite 等框架若不吃 PORT，可改為：npm run dev -- --port {'{port}'} --host 127.0.0.1
          </p>
        </div>
        <div>
          <Label htmlFor="preview-install">安裝命令</Label>
          <Input
            id="preview-install"
            value={previewInstallCommand}
            onChange={(e) => setPreviewInstallCommand(e.target.value)}
            className="mt-1 font-mono text-xs"
            placeholder="npm install"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={previewInstallIfNeeded}
            onChange={(e) => setPreviewInstallIfNeeded(e.target.checked)}
            className="rounded border-border"
          />
          啟動前自動安裝依賴（cwd 有 package.json 且無 node_modules 時）
        </label>
        <Button onClick={save}>儲存預覽設定</Button>
      </div>

      <hr className="border-border" />

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">初始化專案</h2>
        <p className="text-xs text-muted-foreground">
          補齊 PM-AI 所需檔案與目錄（若缺失）：
          <code className="font-mono">.pm-ai/</code> 結構、
          <code className="font-mono">project.yml</code>、Cursor Skill，並重新偵測 Git 根目錄、同步任務。
          不會覆蓋已有任務內容；若已有設定檔會與目前專案名稱對齊。
        </p>
        <Button
          variant="outline"
          disabled={initLoading || project.bindingStatus === 'missing'}
          onClick={async () => {
            if (!projectId) return;
            setInitLoading(true);
            setError('');
            try {
              const result = await projectsApi.initialize(projectId);
              setProject(result.project);
              reloadProjects();
              const parts: string[] = [];
              if (result.structure_was_missing) parts.push('已建立 .pm-ai');
              else parts.push('.pm-ai 已就緒');
              if (result.config_created) parts.push('已建立 project.yml');
              else parts.push('project.yml 已同步');
              parts.push(result.skill.updated ? 'Skill 已更新' : 'Skill 已就緒');
              if (result.git_root) parts.push('已偵測 Git');
              else parts.push('未偵測到 Git');
              setMessage(parts.join(' · '));
              setTimeout(() => setMessage(''), 5000);
              toast.success('專案已初始化');
            } catch (err) {
              setError(err instanceof Error ? err.message : '初始化失敗');
            } finally {
              setInitLoading(false);
            }
          }}
        >
          {initLoading ? '初始化中…' : '初始化專案'}
        </Button>
      </div>

      <hr className="border-border" />

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Cursor Agent Skill</h2>
        <p className="text-xs text-muted-foreground">
          建立專案時會自動安裝到 workspace：
          <code className="block font-mono mt-1 break-all">
            {project.workspacePath}/.cursor/skills/pm-ai-agent/SKILL.md
          </code>
        </p>
        <Button
          variant="outline"
          disabled={skillLoading}
          onClick={async () => {
            if (!projectId) return;
            setSkillLoading(true);
            setError('');
            try {
              const result = await projectsApi.reinstallSkill(projectId);
              setMessage(result.updated ? 'Skill 已更新' : 'Skill 已就緒');
              setTimeout(() => setMessage(''), 3000);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Skill 安裝失敗');
            } finally {
              setSkillLoading(false);
            }
          }}
        >
          {skillLoading ? '安裝中…' : '重新安裝 Skill'}
        </Button>
      </div>

      <hr className="border-border" />

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-red-700">危險操作</h2>
        <p className="text-xs text-muted-foreground">
          封存僅隱藏專案；刪除會永久移除 PM-AI 中的專案、所有任務、worktree 與 workspace 內的{' '}
          <code className="font-mono">.pm-ai/</code> 資料（不會刪除整個 workspace 資料夾）。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={archive}>
            封存專案
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setForceDelete(false);
              setShowDelete(true);
            }}
          >
            刪除專案
          </Button>
        </div>
      </div>

      <Dialog open={showDelete} onClose={() => setShowDelete(false)} title="刪除專案">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            將永久刪除專案 <span className="font-mono">{project.name}</span> 及其所有任務、評論、活動記錄。
            若已使用 Git 隔離，會一併清理 worktree 與任務分支，並刪除 workspace 內的{' '}
            <code className="font-mono">.pm-ai/</code> 目錄。
          </p>
          {project.gitRoot && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={forceDelete}
                onChange={(e) => setForceDelete(e.target.checked)}
              />
              <span>
                強制刪除：若 worktree 被 Cursor 或 dev server 占用無法刪除，仍移除專案記錄（目錄需稍後手動清理）
              </span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowDelete(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={deleteLoading}
              onClick={async () => {
                if (!projectId) return;
                setDeleteLoading(true);
                setError('');
                try {
                  const result = await projectsApi.delete(projectId, { force: forceDelete });
                  await reloadProjects();
                  if (result.warnings?.length) {
                    toast.warning(result.warnings.join(' '));
                  } else {
                    toast.success('專案已刪除');
                  }
                  navigate('/');
                } catch (err) {
                  setError(err instanceof Error ? err.message : '刪除失敗');
                  setShowDelete(false);
                } finally {
                  setDeleteLoading(false);
                }
              }}
            >
              {deleteLoading ? '刪除中…' : '確認刪除'}
            </Button>
          </div>
        </div>
      </Dialog>
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
