import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDb, schema } from '../db/index.js';
import { NotFoundError, ValidationError } from './tasks.js';
import {
  CUSTOM_DECISION_OPTION_ID,
  ReviewPolicySchema,
  type ReviewPolicy,
  type UpdateReviewPolicySchema,
} from '../../shared/schemas.js';
import type { z } from 'zod';

export { CUSTOM_DECISION_OPTION_ID };

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

const CUSTOM_DECISION_OPTION: DecisionOption = {
  id: CUSTOM_DECISION_OPTION_ID,
  label: '自訂輸入',
  description: '填寫說明後提交你的決定',
};

function withCustomOption(options: DecisionOption[]): DecisionOption[] {
  if (options.some((o) => o.id === CUSTOM_DECISION_OPTION_ID)) return options;
  return [...options, CUSTOM_DECISION_OPTION];
}

function now() {
  return new Date().toISOString();
}

function serializeRun(row: typeof schema.autoRuns.$inferSelect) {
  return {
    id: row.id,
    project_id: row.projectId,
    projectId: row.projectId,
    goal: row.goal,
    status: row.status,
    phase: row.phase,
    thread_id: row.threadId,
    checkpoint: JSON.parse(row.checkpointJson ?? '{}') as Record<string, unknown>,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function listAutoRuns(projectId: string) {
  return getDb()
    .select()
    .from(schema.autoRuns)
    .where(eq(schema.autoRuns.projectId, projectId))
    .orderBy(desc(schema.autoRuns.createdAt))
    .all()
    .map(serializeRun);
}

export function getAutoRun(runId: string) {
  const row = getDb().select().from(schema.autoRuns).where(eq(schema.autoRuns.id, runId)).get();
  if (!row) throw new NotFoundError('Auto Run 不存在');
  return serializeRun(row);
}

export function getAutoRunMessages(runId: string) {
  return getDb()
    .select()
    .from(schema.autoRunMessages)
    .where(eq(schema.autoRunMessages.runId, runId))
    .orderBy(schema.autoRunMessages.at)
    .all()
    .map((m) => ({
      id: m.id,
      run_id: m.runId,
      role: m.role,
      content: m.content,
      at: m.at,
    }));
}

export function appendRunMessage(runId: string, role: string, content: string) {
  const id = uuidv4();
  const at = now();
  getDb()
    .insert(schema.autoRunMessages)
    .values({ id, runId, role, content, at })
    .run();
  return { id, run_id: runId, role, content, at };
}

export function createAutoRun(projectId: string, goal: string) {
  const id = uuidv4();
  const ts = now();
  const threadId = uuidv4();
  getDb()
    .insert(schema.autoRuns)
    .values({
      id,
      projectId,
      goal,
      status: 'running',
      phase: 'intake',
      threadId,
      checkpointJson: JSON.stringify({ goal, messages: [] }),
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  appendRunMessage(id, 'user', goal);
  return getAutoRun(id);
}

export function updateAutoRun(
  runId: string,
  patch: {
    status?: string;
    phase?: string;
    checkpoint?: Record<string, unknown>;
    goal?: string;
  },
) {
  const row = getDb().select().from(schema.autoRuns).where(eq(schema.autoRuns.id, runId)).get();
  if (!row) throw new NotFoundError('Auto Run 不存在');
  getDb()
    .update(schema.autoRuns)
    .set({
      status: patch.status ?? row.status,
      phase: patch.phase ?? row.phase,
      goal: patch.goal ?? row.goal,
      checkpointJson:
        patch.checkpoint !== undefined
          ? JSON.stringify(patch.checkpoint)
          : row.checkpointJson,
      updatedAt: now(),
    })
    .where(eq(schema.autoRuns.id, runId))
    .run();
  return getAutoRun(runId);
}

export function pauseAutoRun(runId: string) {
  return updateAutoRun(runId, { status: 'paused' });
}

export function resumeAutoRun(runId: string) {
  const run = getAutoRun(runId);
  if (run.status === 'stopped' || run.status === 'completed') {
    throw new ValidationError('已結束的 Run 不可恢復');
  }
  return updateAutoRun(runId, { status: 'running' });
}

export function stopAutoRun(runId: string) {
  return updateAutoRun(runId, { status: 'stopped', phase: 'stopped' });
}

function serializeDecision(row: typeof schema.decisions.$inferSelect) {
  return {
    id: row.id,
    project_id: row.projectId,
    projectId: row.projectId,
    run_id: row.runId,
    title: row.title,
    summary: row.summary,
    options: JSON.parse(row.optionsJson || '[]') as DecisionOption[],
    recommended_option_id: row.recommendedOptionId,
    chosen_option_id: row.chosenOptionId,
    status: row.status,
    note: row.note,
    created_at: row.createdAt,
    resolved_at: row.resolvedAt,
  };
}

export function listDecisions(projectId: string, status?: string) {
  let rows = getDb()
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.projectId, projectId))
    .orderBy(desc(schema.decisions.createdAt))
    .all();
  if (status) rows = rows.filter((r) => r.status === status);
  return rows.map(serializeDecision);
}

export function getDecision(decisionId: string) {
  const row = getDb()
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, decisionId))
    .get();
  if (!row) throw new NotFoundError('決策不存在');
  return serializeDecision(row);
}

export function createDecision(input: {
  projectId: string;
  runId?: string | null;
  title: string;
  summary?: string;
  options: DecisionOption[];
  recommendedOptionId?: string | null;
}) {
  if (!input.options.length) throw new ValidationError('至少需要一個選項');
  const options = withCustomOption(input.options);
  const id = uuidv4();
  const ts = now();
  getDb()
    .insert(schema.decisions)
    .values({
      id,
      projectId: input.projectId,
      runId: input.runId ?? null,
      title: input.title,
      summary: input.summary ?? '',
      optionsJson: JSON.stringify(options),
      recommendedOptionId: input.recommendedOptionId ?? null,
      chosenOptionId: null,
      status: 'open',
      note: null,
      createdAt: ts,
      resolvedAt: null,
    })
    .run();
  if (input.runId) {
    updateAutoRun(input.runId, { status: 'awaiting_human', phase: 'decision' });
  }
  return getDecision(id);
}

export function resolveDecision(
  decisionId: string,
  chosenOptionId: string,
  note?: string,
) {
  const decision = getDecision(decisionId);
  if (decision.status !== 'open') throw new ValidationError('決策已關閉');

  const noteTrim = note?.trim() ?? '';
  const isCustom = chosenOptionId === CUSTOM_DECISION_OPTION_ID;
  const optionKnown =
    decision.options.some((o) => o.id === chosenOptionId) || isCustom;

  if (!optionKnown) {
    throw new ValidationError('無效的選項');
  }
  if (isCustom && !noteTrim) {
    throw new ValidationError('自訂決策請填寫說明');
  }

  const ts = now();
  getDb()
    .update(schema.decisions)
    .set({
      chosenOptionId,
      status: 'resolved',
      note: noteTrim || null,
      resolvedAt: ts,
    })
    .where(eq(schema.decisions.id, decisionId))
    .run();

  if (decision.run_id) {
    const opt = decision.options.find((o) => o.id === chosenOptionId);
    const label = isCustom ? '自訂輸入' : (opt?.label ?? chosenOptionId);
    let content = `人類已選擇決策「${decision.title}」：${label}`;
    if (noteTrim) content += `\n補充說明：${noteTrim}`;
    appendRunMessage(decision.run_id, 'user', content);
    // Continue orchestration (not wait_events synthesize-only)
    updateAutoRun(decision.run_id, { status: 'running', phase: 'plan' });
  }
  return getDecision(decisionId);
}

function serializeMeeting(row: typeof schema.meetings.$inferSelect) {
  return {
    id: row.id,
    project_id: row.projectId,
    projectId: row.projectId,
    run_id: row.runId,
    topic: row.topic,
    participant_ids: JSON.parse(row.participantIdsJson || '[]') as string[],
    summary: row.summary,
    escalated_to_decision_id: row.escalatedToDecisionId,
    created_at: row.createdAt,
  };
}

export function listMeetings(projectId: string) {
  return getDb()
    .select()
    .from(schema.meetings)
    .where(eq(schema.meetings.projectId, projectId))
    .orderBy(desc(schema.meetings.createdAt))
    .all()
    .map(serializeMeeting);
}

export function getMeeting(meetingId: string) {
  const row = getDb().select().from(schema.meetings).where(eq(schema.meetings.id, meetingId)).get();
  if (!row) throw new NotFoundError('會議不存在');
  const messages = getDb()
    .select()
    .from(schema.meetingMessages)
    .where(eq(schema.meetingMessages.meetingId, meetingId))
    .orderBy(schema.meetingMessages.at)
    .all()
    .map((m) => ({
      id: m.id,
      meeting_id: m.meetingId,
      agent_id: m.agentId,
      agent_name: m.agentName,
      role: m.role,
      content: m.content,
      at: m.at,
    }));
  return { ...serializeMeeting(row), messages };
}

export function createMeeting(input: {
  projectId: string;
  runId?: string | null;
  topic: string;
  participantIds: string[];
  messages?: Array<{ agentId?: string; agentName?: string; role: string; content: string }>;
  summary?: string;
}) {
  const id = uuidv4();
  const ts = now();
  getDb()
    .insert(schema.meetings)
    .values({
      id,
      projectId: input.projectId,
      runId: input.runId ?? null,
      topic: input.topic,
      participantIdsJson: JSON.stringify(input.participantIds),
      summary: input.summary ?? '',
      escalatedToDecisionId: null,
      createdAt: ts,
    })
    .run();
  for (const msg of input.messages ?? []) {
    getDb()
      .insert(schema.meetingMessages)
      .values({
        id: uuidv4(),
        meetingId: id,
        agentId: msg.agentId ?? null,
        agentName: msg.agentName ?? null,
        role: msg.role,
        content: msg.content,
        at: now(),
      })
      .run();
  }
  return getMeeting(id);
}

const defaultPolicy = (): ReviewPolicy =>
  ReviewPolicySchema.parse({
    version: 1,
    ai_review_paths: [],
    ai_review_task_types: [],
    human_verify_paths: ['**'],
    human_verify_notes: '預設：完成後需人類驗收；merge 主分支僅人可操作。',
    default_reviewer_type: 'human',
    confirmed: false,
    confirmed_at: null,
  });

export function getReviewPolicy(projectId: string): ReviewPolicy & { project_id: string } {
  const row = getDb()
    .select()
    .from(schema.reviewPolicies)
    .where(eq(schema.reviewPolicies.projectId, projectId))
    .get();
  if (!row) {
    const policy = defaultPolicy();
    return { ...policy, project_id: projectId };
  }
  const policy = ReviewPolicySchema.parse(JSON.parse(row.policyJson));
  return {
    ...policy,
    version: row.version,
    confirmed: row.confirmed,
    confirmed_at: row.confirmedAt,
    project_id: projectId,
  };
}

export function upsertReviewPolicy(
  projectId: string,
  input: z.infer<typeof UpdateReviewPolicySchema>,
  confirm?: boolean,
) {
  const current = getReviewPolicy(projectId);
  const next = ReviewPolicySchema.parse({
    ...current,
    ...input,
    version: (current.version ?? 1) + (confirm || input.confirmed ? 0 : 0),
    confirmed: confirm ? true : (input.confirmed ?? current.confirmed),
    confirmed_at: confirm ? now() : (input.confirmed_at ?? current.confirmed_at),
  });
  if (confirm) {
    next.confirmed = true;
    next.confirmed_at = now();
    next.version = current.version + 1;
  }
  const ts = now();
  const existing = getDb()
    .select()
    .from(schema.reviewPolicies)
    .where(eq(schema.reviewPolicies.projectId, projectId))
    .get();
  if (existing) {
    getDb()
      .update(schema.reviewPolicies)
      .set({
        version: next.version,
        policyJson: JSON.stringify(next),
        confirmed: next.confirmed,
        confirmedAt: next.confirmed_at ?? null,
        updatedAt: ts,
      })
      .where(eq(schema.reviewPolicies.projectId, projectId))
      .run();
  } else {
    getDb()
      .insert(schema.reviewPolicies)
      .values({
        projectId,
        version: next.version,
        policyJson: JSON.stringify(next),
        confirmed: next.confirmed,
        confirmedAt: next.confirmed_at ?? null,
        updatedAt: ts,
      })
      .run();
  }
  return getReviewPolicy(projectId);
}
