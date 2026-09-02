import { appendRunMessage } from '../../services/auto.js';
import {
  createStaffAgent,
  ensureDefaultStaffAgents,
  listStaffAgents,
  updateStaffAgent,
} from '../../services/agents.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';

export async function ensureStaffNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const plan = state.plan;
  if (!plan) return { phase: 'assign' };

  ensureDefaultStaffAgents(state.projectId);
  const existing = listStaffAgents(state.projectId);
  const byRole = new Map(
    existing
      .filter((e) => e.assignable && e.status !== 'retired' && e.role !== 'orchestrator')
      .map((e) => [e.role, e]),
  );

  for (const s of plan.staff ?? []) {
    if (s.role === 'orchestrator') continue;
    const current = byRole.get(s.role);
    if (current) {
      const nextPrompt = (s.system_prompt ?? '').trim();
      if (nextPrompt && nextPrompt !== current.system_prompt.trim()) {
        const updated = updateStaffAgent(
          current.id,
          {
            system_prompt: nextPrompt,
            ...(s.skills_tags?.length ? { skills_tags: s.skills_tags } : {}),
            ...(s.name?.trim() ? { name: s.name.trim() } : {}),
          },
          'orchestrator',
        );
        byRole.set(s.role, updated as never);
        appendRunMessage(
          state.runId,
          'assistant',
          `已依目標調整 ${updated.name}（${updated.role}）提示詞`,
        );
      }
      continue;
    }
    const created = createStaffAgent(
      state.projectId,
      {
        name: s.name,
        role: s.role,
        system_prompt: s.system_prompt,
        skills_tags: s.skills_tags ?? [],
        assignable: true,
        creation_rationale: `協調者依目標「${state.goal}」新增非常規角色`,
      },
      'orchestrator',
    );
    byRole.set(s.role, created as never);
    appendRunMessage(state.runId, 'assistant', `已建立員工 ${created.name}（${created.role}）`);
  }

  const next = { ...state, phase: 'ensure_staff' };
  syncRunMirror(next);
  return { phase: 'ensure_staff' };
}
