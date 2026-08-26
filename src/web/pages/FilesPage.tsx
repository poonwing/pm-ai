import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  projectsApi,
  Project,
  WorkspaceDirEntry,
  WorkspaceFileContentResponse,
} from '../lib/api';
import { cn } from '../lib/utils';
import { CodePreview } from '../components/CodePreview';

type TreeNodeState = {
  entries?: WorkspaceDirEntry[];
  loading?: boolean;
  error?: string;
  expanded?: boolean;
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function TreeNode({
  entry,
  depth,
  selectedPath,
  nodeState,
  onToggleDir,
  onSelectFile,
}: {
  entry: WorkspaceDirEntry;
  depth: number;
  selectedPath: string | null;
  nodeState: Record<string, TreeNodeState>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const state = nodeState[entry.path] ?? {};
  const isDir = entry.type === 'dir';
  const expanded = Boolean(state.expanded);
  const selected = selectedPath === entry.path;

  return (
    <div>
      <button
        type="button"
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm rounded-md hover:bg-accent/60',
          selected && 'bg-accent font-medium',
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => {
          if (isDir) onToggleDir(entry.path);
          else onSelectFile(entry.path);
        }}
      >
        <span className="w-3 shrink-0 text-muted-foreground text-xs">
          {isDir ? (expanded ? '▾' : '▸') : '·'}
        </span>
        <span className="truncate font-mono text-xs">{entry.name}</span>
      </button>

      {isDir && expanded && (
        <div>
          {state.loading && (
            <div
              className="text-xs text-muted-foreground py-1"
              style={{ paddingLeft: `${22 + depth * 14}px` }}
            >
              載入中…
            </div>
          )}
          {state.error && (
            <div
              className="text-xs text-red-500 py-1"
              style={{ paddingLeft: `${22 + depth * 14}px` }}
            >
              {state.error}
            </div>
          )}
          {state.entries?.length === 0 && !state.loading && !state.error && (
            <div
              className="text-xs text-muted-foreground py-1"
              style={{ paddingLeft: `${22 + depth * 14}px` }}
            >
              （空資料夾）
            </div>
          )}
          {state.entries?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              nodeState={nodeState}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FilesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [rootEntries, setRootEntries] = useState<WorkspaceDirEntry[]>([]);
  const [rootLoading, setRootLoading] = useState(true);
  const [error, setError] = useState('');
  const [nodeState, setNodeState] = useState<Record<string, TreeNodeState>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkspaceFileContentResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const loadRoot = useCallback(async () => {
    if (!projectId) return;
    setRootLoading(true);
    try {
      const [p, listing] = await Promise.all([
        projectsApi.get(projectId),
        projectsApi.listFiles(projectId),
      ]);
      setProject(p);
      setRootEntries(listing.entries);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入失敗');
    } finally {
      setRootLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  const onToggleDir = useCallback(
    async (dirPath: string) => {
      if (!projectId) return;

      const snapshot = nodeState[dirPath];
      if (snapshot?.expanded) {
        setNodeState((prev) => ({
          ...prev,
          [dirPath]: { ...prev[dirPath], expanded: false },
        }));
        return;
      }
      if (snapshot?.entries) {
        setNodeState((prev) => ({
          ...prev,
          [dirPath]: { ...prev[dirPath], expanded: true, error: undefined },
        }));
        return;
      }

      setNodeState((prev) => ({
        ...prev,
        [dirPath]: { ...prev[dirPath], expanded: true, loading: true, error: undefined },
      }));

      try {
        const listing = await projectsApi.listFiles(projectId, dirPath);
        setNodeState((prev) => ({
          ...prev,
          [dirPath]: {
            expanded: true,
            loading: false,
            entries: listing.entries,
          },
        }));
      } catch (err) {
        setNodeState((prev) => ({
          ...prev,
          [dirPath]: {
            expanded: true,
            loading: false,
            error: err instanceof Error ? err.message : '載入失敗',
          },
        }));
      }
    },
    [projectId, nodeState],
  );

  const onSelectFile = useCallback(
    async (filePath: string) => {
      if (!projectId) return;
      setSelectedPath(filePath);
      setPreviewLoading(true);
      setPreviewError('');
      setPreview(null);
      try {
        const content = await projectsApi.getFileContent(projectId, filePath);
        setPreview(content);
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : '預覽失敗');
      } finally {
        setPreviewLoading(false);
      }
    },
    [projectId],
  );

  if (error) {
    return <div className="text-red-500">{error}</div>;
  }

  if (!project || rootLoading) {
    return <div className="text-muted-foreground">載入中…</div>;
  }

  return (
    <div className="h-[calc(100vh-6.5rem)] flex flex-col gap-4 max-w-6xl mx-auto">
      {project.bindingStatus === 'missing' && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 shrink-0">
          Workspace 找不到：{project.workspacePath}。請到
          <Link to={`/projects/${projectId}/settings`} className="underline mx-1">
            專案設定
          </Link>
          重新定位。
        </div>
      )}

      <div className="shrink-0">
        <h1 className="text-xl font-semibold">文件</h1>
        <p className="text-xs text-muted-foreground font-mono mt-1">{project.workspacePath}</p>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(220px,320px)_1fr] gap-4">
        <div className="border border-border rounded-md overflow-auto min-h-[200px]">
          <div className="px-3 py-2 border-b border-border text-xs text-muted-foreground sticky top-0 bg-background">
            專案根目錄
          </div>
          <div className="p-1">
            {rootEntries.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">（空資料夾）</div>
            ) : (
              rootEntries.map((entry) => (
                <TreeNode
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  selectedPath={selectedPath}
                  nodeState={nodeState}
                  onToggleDir={onToggleDir}
                  onSelectFile={onSelectFile}
                />
              ))
            )}
          </div>
        </div>

        <div className="border border-border rounded-md overflow-hidden flex flex-col min-h-[200px]">
          <div className="px-3 py-2 border-b border-border text-xs text-muted-foreground flex items-center justify-between gap-2 shrink-0">
            <span className="font-mono truncate">{selectedPath ?? '選擇左側檔案以預覽'}</span>
            {preview && !preview.binary && !preview.too_large && (
              <span className="shrink-0">{formatBytes(preview.size)}</span>
            )}
          </div>
          <div className="flex-1 overflow-auto">
            {!selectedPath && (
              <div className="text-sm text-muted-foreground p-3">點選左側檔案查看內容。</div>
            )}
            {selectedPath && previewLoading && (
              <div className="text-sm text-muted-foreground p-3">載入中…</div>
            )}
            {selectedPath && previewError && (
              <div className="text-sm text-red-500 p-3">{previewError}</div>
            )}
            {preview && preview.too_large && (
              <div className="text-sm text-muted-foreground p-3">
                檔案過大（{formatBytes(preview.size)}），無法預覽。上限約 512 KB。
              </div>
            )}
            {preview && preview.binary && (
              <div className="text-sm text-muted-foreground p-3">
                二進制檔案（{formatBytes(preview.size)}），無法以文字預覽。
              </div>
            )}
            {preview && !preview.binary && !preview.too_large && preview.content != null && (
              <CodePreview code={preview.content} filePath={preview.path} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
