import { appendRunMessage, updateAutoRun } from '../../services/auto.js';
import { getInbox, reopenTask } from '../../services/tasks.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';
import {
  DESIGN_STAGE_LABELS,
  evaluateRunProgress,
  feedbackQueueFromCheckpoint,
  MAX_FEEDBACK_CHAIN,
  readyPlanTasks,
  rollbackDesignTo,
  type DesignStage,
  type FeedbackItem,
} from '../helpers.js';
import { appendRunEvent } from '../../services/run-events.js';
import { chatCompletion, isModelConfigured } from '../model.js';
import { parseJsonLoose } from '../helpers.js';

type FeedbackAction = 'revise_artifact' | 'reopen_task' | 'note_only';

async function decideFeedbackAction(
  item: FeedbackItem,
): Promise<{ action: FeedbackAction; target_stage: DesignStage | null; reply: string }> {
  if ((item.chain_count ?? 0) >= MAX_FEEDBACK_CHAIN) {
    return {
      action: 'note_only',
      target_stage: null,
      reply: `反饋鏈已達上限（${MAX_FEEDBACK_CHAIN}），改為記下並請人類介入：${item.message}`,
    };
  }
  if (!isModelConfigured()) {
    if (item.target_stage) {
      return {
        action: 'revise_artifact',
        target_stage: item.target_stage,
        reply: `離線模式：將回退設計階段 ${item.target_stage}。`,
      };
    }
    return {
      action: 'note_only',
      target_stage: null,
      reply: `已記下執行反饋（來自 ${item.from_task_id}）：${item.message}`,
    };
  }

  const content = await chatCompletion(
    [
      {
        role: 'system',
        content: `你是 PM-AI 協調者，處理執行階段 agent 反饋。只輸出 JSON：
{"action":"revise_artifact"|"reopen_task"|"note_only","target_stage":"system"|"data"|"coding"|"ui"|null,"reply":string}
- revise_artifact：設計層有問題，需回退設計階段
- reopen_task：需重開某類任務（由後續分派處理，此處只記 note）
- note_only：記下繼續`,
      },
      {
        role: 'user',
        content: `from_task=${item.from_task_id}\ntarget_role=${item.target_role}\ntarget_stage=${item.target_stage ?? ''}\nmessage=${item.message}`,
      },
    ],
    { json: true, temperature: 0.2 },
  );

  try {
    const parsed = parseJsonLoose<{
      action?: string;
      target_stage?: string | null;
      reply?: string;
    }>(content);
    const action = (
      ['revise_artifact', 'reopen_task', 'note_only'].includes(String(parsed.action))
        ? parsed.action
        : 'note_only'
    ) as FeedbackAction;
    const stage = ['system', 'data', 'coding', 'ui'].includes(String(parsed.target_stage))
      ? (parsed.target_stage as DesignStage)
      : item.target_stage ?? null;
    return {
      action,
      target_stage: stage,
      reply: String(parsed.reply ?? content).trim() || '已處理反饋。',
    };
  } catch {
    return {
      action: 'note_only',
      target_stage: null,
      reply: `已記下反饋：${item.message}`,
    };
  }
}

function extractFeedbackFromResultNote(taskId: string, note: string): FeedbackItem | null {
  const m = note.match(/\[\[feedback\]\]([\s\S]*?)\[\[\/feedback\]\]/i);
  if (!m) return null;
  const body = m[1].trim();
  const roleMatch = body.match(/target_role\s*[:=]\s*(\w+)/i);
  const stageMatch = body.match(/target_stage\s*[:=]\s*(system|data|coding|ui)/i);
  const msgMatch = body.match(/message\s*[:=]\s*([\s\S]+)/i);
  return {
    id: `fb_${taskId}_${Date.now()}`,
    from_task_id: taskId,
    target_role: roleMatch?.[1] ?? 'designer',
    target_stage: (stageMatch?.[1] as DesignStage) ?? null,
    message: (msgMatch?.[1] ?? body).trim(),
    status: 'pending',
    created_at: new Date().toISOString(),
    chain_count: 1,
  };
}

export async function synthesizeNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const projectId = state.projectId;
  const runId = state.runId;
  const progress = evaluateRunProgress(projectId, runId);
  const inbox = getInbox().filter((t) => t.projectId === projectId || t.project_id === projectId);

  // Harvest structured feedback from newly completed tasks.
  let feedbackQueue = feedbackQueueFromCheckpoint(state.checkpoint);
  for (const t of progress.done) {
    const note = String((t as { result_note?: string }).result_note ?? '');
    if (!note) continue;
    const already = feedbackQueue.some((f) => f.from_task_id === t.id && f.message);
    if (already) continue;
    const extracted = extractFeedbackFromResultNote(t.id, note);
    if (extracted && !feedbackQueue.some((f) => f.id === extracted.id)) {
      feedbackQueue = [...feedbackQueue, extracted];
    }
  }

  let checkpoint: Record<string, unknown> = {
    ...state.checkpoint,
    feedback_queue: feedbackQueue,
  };
  let routeToDesign = false;
  let routeToAssign = false;

  const pending = feedbackQueue.filter((f) => f.status === 'pending');
  for (const item of pending) {
    const decision = await decideFeedbackAction(item);
    appendRunMessage(runId, 'assistant', `【執行反饋】${decision.reply}`);
    const updated: FeedbackItem = {
      ...item,
      status: decision.action === 'note_only' ? 'handled' : 'handled',
      action: decision.action,
    };

    if (decision.action === 'revise_artifact' && decision.target_stage) {
      const designRaw = checkpoint.design;
      const base =
        designRaw && typeof designRaw === 'object' && !Array.isArray(designRaw)
          ? (designRaw as Parameters<typeof rollbackDesignTo>[0])
          : {
              active_stage: decision.target_stage,
              skipped: [] as DesignStage[],
              artifacts: {},
              confirmed: {},
              design_done: false,
            };
      const rolled = rollbackDesignTo(base, decision.target_stage);
      checkpoint = {
        ...checkpoint,
        design: rolled,
        force_redesign: true,
      };
      appendRunMessage(
        runId,
        'assistant',
        `協調者決定回退至「${DESIGN_STAGE_LABELS[decision.target_stage]}」修正設計。`,
      );
      routeToDesign = true;
      updated.status = 'handled';
    } else if (decision.action === 'reopen_task') {
      try {
        reopenTask(projectId, item.from_task_id);
        appendRunMessage(runId, 'assistant', `已重開任務 ${item.from_task_id} 以納入反饋。`);
      } catch {
        /* ignore */
      }
    }

    feedbackQueue = feedbackQueue.map((f) => (f.id === item.id ? updated : f));
  }
  checkpoint = { ...checkpoint, feedback_queue: feedbackQueue };

  if (routeToDesign) {
    const next = {
      ...state,
      phase: 'design',
      status: 'running',
      checkpoint,
    };
    syncRunMirror(next);
    return { phase: 'design', status: 'running', checkpoint };
  }

  // Wave dispatch: enqueue next ready tasks if any.
  const plan = state.plan;
  if (plan?.tasks?.length) {
    const ready = readyPlanTasks(plan, {
      task_map:
        checkpoint.dispatch && typeof checkpoint.dispatch === 'object'
          ? ((checkpoint.dispatch as { task_map?: Record<string, string> }).task_map ?? {})
          : {},
      enqueued:
        checkpoint.dispatch && typeof checkpoint.dispatch === 'object'
          ? ((checkpoint.dispatch as { enqueued?: string[] }).enqueued ?? [])
          : [],
      waves_done:
        checkpoint.dispatch && typeof checkpoint.dispatch === 'object'
          ? Number((checkpoint.dispatch as { waves_done?: number }).waves_done ?? 0)
          : 0,
    }, projectId);
    if (ready.length) {
      appendRunMessage(
        runId,
        'assistant',
        `依賴已滿足，準備派發下一波 ${ready.length} 個任務：${ready.map((t) => t.id).join(', ')}`,
      );
      routeToAssign = true;
    }
  }

  const summary = `${progress.summary}，inbox ${inbox.length}`;
  appendRunMessage(runId, 'assistant', summary);

  if (progress.canComplete && !routeToAssign) {
    const reason =
      progress.tasks.length === 0
        ? '沒有待辦任務，結束 Auto Run'
        : progress.cancelled.length && !progress.done.length
          ? `本 Run 任務均已取消（${progress.cancelled.length}），結束 Auto Run`
          : progress.cancelled.length
            ? `本 Run 任務均已結束（完成 ${progress.done.length}、取消 ${progress.cancelled.length}），結束 Auto Run`
            : `本 Run 任務均已完成並通過審查（${progress.done.length}），結束 Auto Run`;
    appendRunMessage(runId, 'assistant', reason);
    appendRunEvent(runId, 'status_changed', 'system', reason, {
      data: {
        canComplete: true,
        done: progress.done.length,
        cancelled: progress.cancelled.length,
        scopedToRun: progress.scopedToRun,
      },
    });
    const next = { ...state, status: 'completed', phase: 'completed', checkpoint };
    syncRunMirror(next);
    updateAutoRun(runId, { status: 'completed', phase: 'completed', checkpoint });
    return { status: 'completed', phase: 'completed', checkpoint };
  }

  if (progress.open.length === 0 && progress.pendingHuman.length > 0) {
    appendRunMessage(
      runId,
      'assistant',
      `實作已結束，尚有 ${progress.pendingHuman.length} 個任務待你驗收（驗收通過後才會解鎖下游任務）：${progress.pendingHuman.map((t) => t.id).join(', ')}`,
    );
  } else if (progress.open.length === 0 && progress.pendingAi.length > 0) {
    appendRunMessage(
      runId,
      'assistant',
      `實作已結束，尚有 ${progress.pendingAi.length} 個任務待 AI 復查。`,
    );
  } else if (progress.open.length) {
    appendRunMessage(
      runId,
      'system',
      `尚未結束的任務：${progress.open.map((t) => `${t.id}(${t.status})`).join(', ')}`,
    );
  }

  if (routeToAssign) {
    const next = { ...state, phase: 'assign', status: 'running', checkpoint };
    syncRunMirror(next);
    return { phase: 'assign', status: 'running', checkpoint };
  }

  const next = { ...state, phase: 'synthesize', status: 'running', checkpoint };
  syncRunMirror(next);
  return { phase: 'synthesize', status: 'running', checkpoint };
}

export function routeAfterSynthesize(state: OrchestratorStateType): string {
  if (state.status === 'completed' || state.phase === 'completed') return 'endDone';
  if (state.phase === 'design' || (state.checkpoint && state.checkpoint.force_redesign === true)) {
    return 'design';
  }
  if (state.phase === 'assign') return 'assign';
  return 'waitEvents';
}
