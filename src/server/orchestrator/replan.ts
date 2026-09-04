import {
  appendRunMessage,
  createDecision,
  getAutoRun,
  pauseAutoRun,
  resumeAutoRun,
  updateAutoRun,
} from '../services/auto.js';
import { cancelTask, listProjectTasks } from '../services/tasks.js';
import {
  collectRunTaskIds,
  emptyDesignCheckpoint,
  REQUIREMENT_CHANGE_DECISION_TITLE,
} from './helpers.js';

/** Cancel open Runner jobs and open tasks for this Auto Run before replan/redesign. */
export async function cancelRunOpenWork(
  runId: string,
  opts?: { reason?: string; includeDone?: boolean },
): Promise<{ cancelledTaskIds: string[] }> {
  const run = getAutoRun(runId);
  const reason = opts?.reason ?? '需求變更：取消進行中工作以重新規劃';
  try {
    const { cancelForAutoRun } = await import('../runner/index.js');
    cancelForAutoRun(runId);
  } catch {
    /* ignore */
  }

  const runIds = new Set(collectRunTaskIds(run));
  const cancelledTaskIds: string[] = [];
  for (const t of listProjectTasks(run.project_id)) {
    if (!runIds.has(t.id)) continue;
    if (t.status === 'cancelled') continue;
    if (!opts?.includeDone && t.status === 'done') continue;
    if (t.status === 'todo' || t.status === 'in_progress' || t.status === 'draft') {
      try {
        cancelTask(run.project_id, t.id, reason);
        cancelledTaskIds.push(t.id);
      } catch {
        /* ignore */
      }
    }
  }

  if (cancelledTaskIds.length) {
    appendRunMessage(
      runId,
      'assistant',
      `已取消 ${cancelledTaskIds.length} 個進行中任務：${cancelledTaskIds.join(', ')}`,
    );
  }
  return { cancelledTaskIds };
}

export async function openRequirementChangeDecision(
  runId: string,
  changeSummary: string,
): Promise<ReturnType<typeof createDecision>> {
  const run = getAutoRun(runId);
  pauseAutoRun(runId);
  try {
    const { cancelForAutoRun } = await import('../runner/index.js');
    cancelForAutoRun(runId);
  } catch {
    /* ignore */
  }

  updateAutoRun(runId, {
    checkpoint: {
      ...run.checkpoint,
      pending_requirement_change: changeSummary,
    },
  });

  appendRunMessage(
    runId,
    'assistant',
    `偵測到可能的需求變更，已暫停 Runner。請選擇處理方式：\n「${changeSummary.slice(0, 200)}」`,
  );

  return createDecision({
    projectId: run.project_id,
    runId,
    title: REQUIREMENT_CHANGE_DECISION_TITLE,
    summary: changeSummary.slice(0, 2000),
    options: [
      {
        id: 'note_continue',
        label: '僅記下，繼續執行',
        description: '不取消任務，恢復 Runner（若已中斷需手動重試）',
      },
      {
        id: 'partial_replan',
        label: '局部重派',
        description: '取消未完成任務並依新指示重新規劃分派（保留設計）',
      },
      {
        id: 'full_redesign',
        label: '全面重規劃',
        description: '取消未完成任務並回到設計階段',
      },
    ],
    recommendedOptionId: 'partial_replan',
  });
}

export async function applyRequirementChangeDecision(
  runId: string,
  optionId: string,
): Promise<'tick' | 'replan' | 'redesign' | 'resume'> {
  const run = getAutoRun(runId);
  const changeText =
    typeof run.checkpoint.pending_requirement_change === 'string'
      ? run.checkpoint.pending_requirement_change
      : '';

  if (optionId === 'note_continue') {
    updateAutoRun(runId, {
      status: 'running',
      phase: run.phase === 'decision' ? 'wait_events' : run.phase,
      checkpoint: {
        ...run.checkpoint,
        pending_requirement_change: null,
      },
    });
    appendRunMessage(runId, 'assistant', '已記下補充，繼續執行（不重規劃）。若 Runner 已中斷可回覆「重試」。');
    resumeAutoRun(runId);
    return 'resume';
  }

  if (optionId === 'full_redesign') {
    await cancelRunOpenWork(runId, { reason: '全面重規劃：取消未完成任務' });
    const latest = getAutoRun(runId);
    const goal = changeText.trim()
      ? `${latest.goal}\n\n【需求變更】${changeText.trim()}`
      : latest.goal;
    updateAutoRun(runId, {
      status: 'running',
      phase: 'design',
      goal,
      checkpoint: {
        ...latest.checkpoint,
        pending_requirement_change: null,
        force_redesign: true,
        design: emptyDesignCheckpoint(),
        requirements_summary: changeText.trim() || latest.checkpoint.requirements_summary,
        created_task_ids: [],
        dispatch: { task_map: {}, enqueued: [], waves_done: 0 },
        plan: null,
      },
    });
    appendRunMessage(runId, 'assistant', '將取消未完成工作並回到設計階段重新對齊。');
    return 'redesign';
  }

  // partial_replan (default)
  await cancelRunOpenWork(runId, { reason: '局部重派：取消未完成任務' });
  const latest = getAutoRun(runId);
  const goal = changeText.trim()
    ? `${latest.goal}\n\n【需求變更】${changeText.trim()}`
    : latest.goal;
  updateAutoRun(runId, {
    status: 'running',
    phase: 'plan',
    goal,
    checkpoint: {
      ...latest.checkpoint,
      pending_requirement_change: null,
      force_redesign: false,
      created_task_ids: [],
      dispatch: { task_map: {}, enqueued: [], waves_done: 0 },
      plan: null,
      requirements_summary: changeText.trim() || latest.checkpoint.requirements_summary,
    },
  });
  appendRunMessage(runId, 'assistant', '將依新指示取消未完成任務並重新規劃分派（保留既有設計產物）。');
  return 'replan';
}
