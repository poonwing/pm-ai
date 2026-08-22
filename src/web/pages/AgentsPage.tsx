import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { agentsApi, StaffAgent } from '../lib/api';
import { Button, Input, Textarea, Label, Dialog, Badge } from '../components/ui';

const emptyForm = () => ({
  name: '',
  role: 'developer',
  system_prompt: '',
  skills_tags: '',
  assignable: false,
});

export function AgentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [agents, setAgents] = useState<StaffAgent[]>([]);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<StaffAgent | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setAgents(await agentsApi.list(projectId));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setForm(emptyForm());
    setEditing(null);
    setShowCreate(true);
  };

  const openEdit = (a: StaffAgent) => {
    setEditing(a);
    setForm({
      name: a.name,
      role: a.role,
      system_prompt: a.system_prompt,
      skills_tags: a.skills_tags.join(', '),
      assignable: a.assignable,
    });
    setShowCreate(true);
  };

  const handleSave = async () => {
    if (!projectId) return;
    if (!form.name.trim() || !form.system_prompt.trim()) {
      setError('名稱與提示詞必填');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const tags = form.skills_tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (editing) {
        await agentsApi.update(editing.id, {
          name: form.name.trim(),
          role: form.role.trim(),
          system_prompt: form.system_prompt,
          skills_tags: tags,
          assignable: form.assignable,
        });
      } else {
        await agentsApi.create(projectId, {
          name: form.name.trim(),
          role: form.role.trim(),
          system_prompt: form.system_prompt,
          skills_tags: tags,
          assignable: form.assignable,
        });
      }
      setShowCreate(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '儲存失敗');
    } finally {
      setSaving(false);
    }
  };

  const toggleAssignable = async (a: StaffAgent) => {
    await agentsApi.update(a.id, { assignable: !a.assignable });
    await load();
  };

  const retire = async (a: StaffAgent) => {
    if (!confirm(`停用 ${a.name}？`)) return;
    await agentsApi.retire(a.id);
    await load();
  };

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">AI 員工</h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理角色與提示詞；打開「允許分派」後，協調者才能派任務給該員工。
          </p>
        </div>
        <Button onClick={openCreate}>新建員工</Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-col gap-3">
        {agents.map((a) => (
          <div
            key={a.id}
            className="border border-border rounded-lg p-4 flex flex-col gap-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{a.name}</span>
                  <Badge>{a.role}</Badge>
                  <Badge className="bg-zinc-100 text-zinc-700">{a.status}</Badge>
                  {a.assignable ? (
                    <Badge className="bg-emerald-100 text-emerald-800">可分派</Badge>
                  ) : (
                    <Badge className="bg-amber-100 text-amber-800">未開放分派</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    by {a.created_by} · {a.prompt_source}
                  </span>
                </div>
                {a.creation_rationale && (
                  <p className="text-xs text-muted-foreground mt-1">{a.creation_rationale}</p>
                )}
                <p className="text-sm mt-2 whitespace-pre-wrap line-clamp-3 text-zinc-700">
                  {a.system_prompt}
                </p>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                {a.role !== 'orchestrator' && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(a)}>
                      編輯
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleAssignable(a)}>
                      {a.assignable ? '關閉分派' : '允許分派'}
                    </Button>
                    {a.status !== 'retired' && (
                      <Button size="sm" variant="ghost" onClick={() => retire(a)}>
                        停用
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
        {agents.length === 0 && (
          <p className="text-sm text-muted-foreground">尚無員工。可新建，或在 Auto 模式讓協調者生成。</p>
        )}
      </div>

      <Dialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={editing ? '編輯 AI 員工' : '新建 AI 員工'}
      >
        <div className="flex flex-col gap-3">
          <div>
            <Label>名稱</Label>
            <Input
              className="mt-1"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <Label>角色</Label>
            <Input
              className="mt-1"
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              placeholder="developer / tester / designer / reviewer"
            />
          </div>
          <div>
            <Label>系統提示詞</Label>
            <Textarea
              className="mt-1"
              rows={8}
              value={form.system_prompt}
              onChange={(e) => setForm((f) => ({ ...f, system_prompt: e.target.value }))}
            />
          </div>
          <div>
            <Label>能力標籤（逗號分隔）</Label>
            <Input
              className="mt-1"
              value={form.skills_tags}
              onChange={(e) => setForm((f) => ({ ...f, skills_tags: e.target.value }))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.assignable}
              onChange={(e) => setForm((f) => ({ ...f, assignable: e.target.checked }))}
            />
            允許協調者分派工作給此員工
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? '儲存中…' : '儲存'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
