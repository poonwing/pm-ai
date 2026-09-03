/**
 * Structured Auto Run event log (方案 C).
 * Parallel to chat messages — filterable timeline for debugging.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

export const RUN_EVENT_CATEGORIES = [
  'graph',
  'runner',
  'ai_review',
  'decision',
  'system',
] as const;
export type RunEventCategory = (typeof RUN_EVENT_CATEGORIES)[number];

export const RUN_EVENT_TYPES = [
  'run_started',
  'phase_changed',
  'status_changed',
  'interrupt',
  'tick',
  'runner_started',
  'runner_completed',
  'runner_failed',
  'runner_retry',
  'ai_review_dispatch',
  'ai_review_started',
  'ai_review_approved',
  'ai_review_rejected',
  'ai_review_failed',
  'ai_review_skipped',
  'decision_opened',
  'decision_resolved',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type RunEvent = {
  id: string;
  run_id: string;
  category: RunEventCategory;
  type: RunEventType | string;
  summary: string;
  data: Record<string, unknown>;
  task_id: string | null;
  at: string;
};

function now() {
  return new Date().toISOString();
}

function serialize(row: typeof schema.autoRunEvents.$inferSelect): RunEvent {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.dataJson || '{}') as Record<string, unknown>;
  } catch {
    data = {};
  }
  return {
    id: row.id,
    run_id: row.runId,
    category: row.category as RunEventCategory,
    type: row.type,
    summary: row.summary,
    data,
    task_id: row.taskId,
    at: row.at,
  };
}

export function appendRunEvent(
  runId: string,
  type: RunEventType | string,
  category: RunEventCategory,
  summary: string,
  opts?: {
    data?: Record<string, unknown>;
    taskId?: string | null;
  },
): RunEvent {
  const id = uuidv4();
  const at = now();
  const data = opts?.data ?? {};
  getDb()
    .insert(schema.autoRunEvents)
    .values({
      id,
      runId,
      category,
      type,
      summary,
      dataJson: JSON.stringify(data),
      taskId: opts?.taskId ?? null,
      at,
    })
    .run();
  return {
    id,
    run_id: runId,
    category,
    type,
    summary,
    data,
    task_id: opts?.taskId ?? null,
    at,
  };
}

export function listRunEvents(
  runId: string,
  opts?: { category?: string; limit?: number },
): RunEvent[] {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
  const db = getDb();
  const rows = opts?.category
    ? db
        .select()
        .from(schema.autoRunEvents)
        .where(
          and(
            eq(schema.autoRunEvents.runId, runId),
            eq(schema.autoRunEvents.category, opts.category),
          ),
        )
        .orderBy(desc(schema.autoRunEvents.at))
        .limit(limit)
        .all()
    : db
        .select()
        .from(schema.autoRunEvents)
        .where(eq(schema.autoRunEvents.runId, runId))
        .orderBy(desc(schema.autoRunEvents.at))
        .limit(limit)
        .all();

  // Return chronological (oldest → newest) for timeline UI
  return rows.map(serialize).reverse();
}

export function deleteRunEventsForRuns(runIds: string[]) {
  if (!runIds.length) return;
  const db = getDb();
  for (const runId of runIds) {
    db.delete(schema.autoRunEvents).where(eq(schema.autoRunEvents.runId, runId)).run();
  }
}
