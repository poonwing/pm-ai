import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDb, schema } from '../db/index.js';
import { NotFoundError, ValidationError } from './tasks.js';
import type {
  CreateStaffAgentSchema,
  UpdateStaffAgentSchema,
} from '../../shared/schemas.js';
import type { z } from 'zod';

function now() {
  return new Date().toISOString();
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function serializeStaffAgent(row: typeof schema.staffAgents.$inferSelect) {
  return {
    id: row.id,
    project_id: row.projectId,
    projectId: row.projectId,
    name: row.name,
    role: row.role,
    system_prompt: row.systemPrompt,
    skills_tags: parseTags(row.skillsTags),
    status: row.status,
    assignable: row.assignable,
    created_by: row.createdBy,
    prompt_source: row.promptSource,
    creation_rationale: row.creationRationale,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function listStaffAgents(projectId: string, opts?: { assignableOnly?: boolean }) {
  const db = getDb();
  let rows = db
    .select()
    .from(schema.staffAgents)
    .where(eq(schema.staffAgents.projectId, projectId))
    .orderBy(desc(schema.staffAgents.createdAt))
    .all();
  if (opts?.assignableOnly) {
    rows = rows.filter((r) => r.assignable && r.status !== 'retired' && r.role !== 'orchestrator');
  }
  return rows.map(serializeStaffAgent);
}

export function getStaffAgent(agentId: string) {
  const db = getDb();
  const row = db.select().from(schema.staffAgents).where(eq(schema.staffAgents.id, agentId)).get();
  if (!row) throw new NotFoundError('AI 員工不存在');
  return serializeStaffAgent(row);
}

export function getStaffAgentInProject(projectId: string, agentId: string) {
  const db = getDb();
  const row = db
    .select()
    .from(schema.staffAgents)
    .where(and(eq(schema.staffAgents.id, agentId), eq(schema.staffAgents.projectId, projectId)))
    .get();
  if (!row) throw new NotFoundError('AI 員工不存在');
  return serializeStaffAgent(row);
}

export function ensureOrchestratorAgent(projectId: string) {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.staffAgents)
    .where(
      and(eq(schema.staffAgents.projectId, projectId), eq(schema.staffAgents.role, 'orchestrator')),
    )
    .get();
  if (existing) return serializeStaffAgent(existing);

  const ts = now();
  const id = uuidv4();
  db.insert(schema.staffAgents)
    .values({
      id,
      projectId,
      name: '協調者',
      role: 'orchestrator',
      systemPrompt:
        '你是專案協調者（Orchestrator）。你負責理解人類目標、規劃任務、建立/分派 AI 員工、必要時開會或提出決策選項請人類拍板。你不直接改業務程式碼；分派時只使用 assignable=true 的員工。',
      skillsTags: '[]',
      status: 'idle',
      assignable: false,
      createdBy: 'system',
      promptSource: 'orchestrator_generated',
      creationRationale: '系統預設協調者',
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return getStaffAgent(id);
}

export function createStaffAgent(
  projectId: string,
  input: z.infer<typeof CreateStaffAgentSchema>,
  createdBy: 'human' | 'orchestrator',
) {
  if (input.role === 'orchestrator') {
    throw new ValidationError('不可手動建立 orchestrator 角色，請使用系統預設協調者');
  }
  ensureOrchestratorAgent(projectId);
  const ts = now();
  const id = uuidv4();
  const assignable = input.assignable ?? createdBy === 'orchestrator';
  const promptSource = createdBy === 'orchestrator' ? 'orchestrator_generated' : 'human_written';

  getDb()
    .insert(schema.staffAgents)
    .values({
      id,
      projectId,
      name: input.name,
      role: input.role,
      systemPrompt: input.system_prompt,
      skillsTags: JSON.stringify(input.skills_tags ?? []),
      status: 'idle',
      assignable,
      createdBy,
      promptSource,
      creationRationale: input.creation_rationale ?? null,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();

  return getStaffAgent(id);
}

export function updateStaffAgent(
  agentId: string,
  input: z.infer<typeof UpdateStaffAgentSchema>,
  editor: 'human' | 'orchestrator' = 'human',
) {
  const db = getDb();
  const row = db.select().from(schema.staffAgents).where(eq(schema.staffAgents.id, agentId)).get();
  if (!row) throw new NotFoundError('AI 員工不存在');
  if (row.role === 'orchestrator' && input.role && input.role !== 'orchestrator') {
    throw new ValidationError('不可變更協調者角色類型');
  }

  let promptSource = row.promptSource;
  if (input.system_prompt !== undefined && editor === 'human') {
    promptSource = row.promptSource === 'human_written' ? 'human_written' : 'human_edited';
  }

  db.update(schema.staffAgents)
    .set({
      name: input.name ?? row.name,
      role: input.role ?? row.role,
      systemPrompt: input.system_prompt ?? row.systemPrompt,
      skillsTags:
        input.skills_tags !== undefined ? JSON.stringify(input.skills_tags) : row.skillsTags,
      assignable: input.assignable ?? row.assignable,
      status: input.status ?? row.status,
      creationRationale:
        input.creation_rationale !== undefined ? input.creation_rationale : row.creationRationale,
      promptSource,
      updatedAt: now(),
    })
    .where(eq(schema.staffAgents.id, agentId))
    .run();

  return getStaffAgent(agentId);
}

export function retireStaffAgent(agentId: string) {
  return updateStaffAgent(agentId, { status: 'retired', assignable: false }, 'human');
}

export function findAssignableByRole(projectId: string, role: string) {
  return listStaffAgents(projectId, { assignableOnly: true }).filter((a) => a.role === role);
}
