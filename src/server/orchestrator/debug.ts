/**
 * Read-only Run Inspector snapshot for Auto debugging.
 */
import { getAutoRun, listDecisions } from '../services/auto.js';
import { listProjectTasks } from '../services/tasks.js';
import { getRunnerStatus } from '../runner/index.js';
import { isPendingReview } from '../../shared/schemas.js';
import { isModelConfigured } from './model.js';
import { getCompiledOrchestratorGraph } from './graph.js';
import { graphHasPendingInterrupt } from './sync.js';
import {
  checkpointFlag,
  collectRunTaskIds,
  createdTaskIdsFromCheckpoint,
  isClarified,
  runnerRetryCountsFromCheckpoint,
  runnerStallNotifiedFromCheckpoint,
} from './helpers.js';
import { listAiReviewDebug } from './ai-review.js';
import { listRunEvents } from '../services/run-events.js';

export type BlockedReason =
  | 'none'
  | 'stopped'
  | 'completed'
  | 'paused'
  | 'awaiting_human'
  | 'awaiting_decision'
  | 'wait_runner'
  | 'wait_ai_review'
  | 'ai_review_cooldown'
  | 'no_model'
  | 'wait_events'
  | 'unknown';

const BLOCKED_HINTS: Record<BlockedReason, string> = {
  none: '目前無明顯阻塞；可觀察日誌或點「推進一步」。',
  stopped: 'Run 已停止，需重新啟動新的 Auto Run。',
  completed: 'Run 已完成。',
  paused: 'Run 已暫停，點「繼續」後才會推進。',
  awaiting_human: '等待人類回覆（澄清 / 政策 / 指示）。',
  awaiting_decision: '有未關閉的決策，請在 Auto 頁選擇選項。',
  wait_runner: '等待 Runner 執行任務（queued / claiming / running）。',
  wait_ai_review:
    '有任務待 AI 復查。看下方「AI 復查狀態」：若顯示「復查中」請等 GLM 回傳；若「未在執行」請再點「推進一步」。',
  ai_review_cooldown: 'AI 復查剛失敗，冷卻中；點「推進一步」可立即強制重試。',
  no_model: '未配置 ZAI_API_KEY，無法執行協調者 LLM / AI 復查。',
  wait_events: '圖停在 waitEvents interrupt，等 Runner 事件或手動推進。',
  unknown: '狀態不明，請查看 graph / checkpoint。',
};

function pickCheckpointSummary(cp: Record<string, unknown>) {
  const design =
    cp.design && typeof cp.design === 'object' && !Array.isArray(cp.design)
      ? (cp.design as {
          active_stage?: string;
          design_done?: boolean;
          skipped?: string[];
        })
      : null;
  const dispatch =
    cp.dispatch && typeof cp.dispatch === 'object' && !Array.isArray(cp.dispatch)
      ? (cp.dispatch as { waves_done?: number; enqueued?: string[] })
      : null;
  return {
    research_done: checkpointFlag(cp, 'research_done'),
    research_task_id: typeof cp.research_task_id === 'string' ? cp.research_task_id : null,
    skip_clarify_after_research: checkpointFlag(cp, 'skip_clarify_after_research'),
    clarified: isClarified(cp),
    design: design
      ? {
          active_stage: design.active_stage ?? null,
          design_done: Boolean(design.design_done),
          skipped: Array.isArray(design.skipped) ? design.skipped : [],
        }
      : null,
    force_redesign: checkpointFlag(cp, 'force_redesign'),
    dispatch_waves: dispatch ? Number(dispatch.waves_done ?? 0) : 0,
    dispatch_enqueued: Array.isArray(dispatch?.enqueued) ? dispatch!.enqueued.length : 0,
    feedback_pending: Array.isArray(cp.feedback_queue)
      ? cp.feedback_queue.filter(
          (f) => f && typeof f === 'object' && (f as { status?: string }).status === 'pending',
        ).length
      : 0,
    created_task_ids: createdTaskIdsFromCheckpoint(cp),
    plan_task_count: Array.isArray((cp.plan as { tasks?: unknown[] } | undefined)?.tasks)
      ? ((cp.plan as { tasks: unknown[] }).tasks.length)
      : null,
    runner_retry_counts: runnerRetryCountsFromCheckpoint(cp),
    runner_stall_notified: runnerStallNotifiedFromCheckpoint(cp),
  };
}

function deriveBlockedReason(input: {
  runStatus: string;
  runPhase: string;
  openDecisions: number;
  modelConfigured: boolean;
  activeRunnerCount: number;
  pendingAi: ReturnType<typeof listAiReviewDebug>;
  pendingInterrupt: boolean;
}): BlockedReason {
  const { runStatus, runPhase, openDecisions, modelConfigured, activeRunnerCount, pendingAi, pendingInterrupt } =
    input;

  if (runStatus === 'stopped') return 'stopped';
  if (runStatus === 'completed') return 'completed';
  if (runStatus === 'paused') return 'paused';
  if (openDecisions > 0) return 'awaiting_decision';
  if (runStatus === 'awaiting_human') return 'awaiting_human';

  if (pendingAi.length > 0) {
    if (!modelConfigured) return 'no_model';
    if (pendingAi.some((r) => r.inFlight)) return 'wait_ai_review';
    if (pendingAi.every((r) => r.cooldownRemainingMs > 0)) return 'ai_review_cooldown';
    return 'wait_ai_review';
  }

  if (activeRunnerCount > 0) return 'wait_runner';
  if (pendingInterrupt && (runPhase === 'wait_events' || runPhase === 'synthesize')) {
    return 'wait_events';
  }
  if (runStatus === 'running') return 'none';
  return 'unknown';
}

async function readGraphDebug(threadId: string) {
  try {
    const graph = getCompiledOrchestratorGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
    const values = (snapshot.values ?? {}) as Record<string, unknown>;
    const pendingInterrupt = graphHasPendingInterrupt(snapshot);
    const next = Array.isArray(snapshot.next) ? snapshot.next.map(String) : [];
    const tasks = (snapshot.tasks ?? []).map((t) => ({
      id: String((t as { id?: string }).id ?? ''),
      name: String((t as { name?: string }).name ?? ''),
      interruptCount: Array.isArray((t as { interrupts?: unknown[] }).interrupts)
        ? (t as { interrupts: unknown[] }).interrupts.length
        : 0,
    }));

    return {
      hasGraphState: Boolean(values.runId),
      pendingInterrupt,
      next,
      tasks,
      values: {
        phase: typeof values.phase === 'string' ? values.phase : null,
        status: typeof values.status === 'string' ? values.status : null,
        pendingCommand: values.pendingCommand ?? null,
        stopRequested: Boolean(values.stopRequested),
        skipClarify: Boolean(values.skipClarify),
        forceReplan: Boolean(values.forceReplan),
        halt: Boolean(values.halt),
        createdTaskIds: Array.isArray(values.createdTaskIds)
          ? values.createdTaskIds.filter((id): id is string => typeof id === 'string')
          : [],
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      hasGraphState: false,
      pendingInterrupt: false,
      next: [] as string[],
      tasks: [] as Array<{ id: string; name: string; interruptCount: number }>,
      values: null as null,
      error: msg,
    };
  }
}

export async function getRunDebugSnapshot(runId: string) {
  const run = getAutoRun(runId);
  const projectId = run.project_id;
  const cp = (run.checkpoint ?? {}) as Record<string, unknown>;
  const runTaskIds = new Set(collectRunTaskIds(run, { includeAllPending: true }));
  const allTasks = listProjectTasks(projectId);
  const runLive = ['running', 'awaiting_human', 'paused'].includes(run.status);

  // Live runs: also surface any project task awaiting AI review (helps debug stalls).
  if (runLive) {
    for (const t of allTasks) {
      if (!isPendingReview(t as Parameters<typeof isPendingReview>[0])) continue;
      const rt = t.review?.reviewer_type;
      if (rt === 'agent' || rt === 'orchestrator') runTaskIds.add(t.id);
    }
  }

  const tasks = allTasks.filter((t) => runTaskIds.has(t.id));

  const pendingReview = tasks.filter((t) =>
    isPendingReview(t as Parameters<typeof isPendingReview>[0]),
  );
  const pendingAi = listAiReviewDebug(projectId).filter((r) => runTaskIds.has(r.taskId));
  const pendingHuman = pendingReview.filter(
    (t) => !t.review || t.review.reviewer_type === 'human',
  );

  const runner = getRunnerStatus(projectId);
  const jobs = runner.jobs.filter(
    (j) =>
      j.kind !== 'studio' &&
      (j.autoRunId === runId || (runTaskIds.has(j.taskId) && !j.autoRunId)),
  );
  const activeJobs = jobs.filter((j) =>
    ['queued', 'claiming', 'running'].includes(j.status),
  );

  const openDecisions = listDecisions(projectId, 'open').filter((d) => d.run_id === runId);
  const modelConfigured = isModelConfigured();
  const graph = await readGraphDebug(run.thread_id);

  const blockedReason = deriveBlockedReason({
    runStatus: run.status,
    runPhase: run.phase,
    openDecisions: openDecisions.length,
    modelConfigured,
    activeRunnerCount: activeJobs.length,
    pendingAi,
    pendingInterrupt: graph.pendingInterrupt,
  });

  const taskMatrix = {
    total: tasks.length,
    draft: tasks.filter((t) => t.status === 'draft').length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
    cancelled: tasks.filter((t) => t.status === 'cancelled').length,
    pending_ai_review: pendingAi.length,
    pending_human_review: pendingHuman.length,
  };

  const inFlight = pendingAi.filter((r) => r.inFlight);
  const onCooldown = pendingAi.filter((r) => !r.inFlight && r.cooldownRemainingMs > 0);
  const ready = pendingAi.filter((r) => !r.inFlight && r.cooldownRemainingMs <= 0);
  let aiReviewStatus: 'none' | 'in_flight' | 'cooldown' | 'idle_pending' | 'no_model' = 'none';
  let aiReviewSummary = '目前沒有待 AI 復查的任務。';
  if (pendingAi.length) {
    if (!modelConfigured) {
      aiReviewStatus = 'no_model';
      aiReviewSummary = `有 ${pendingAi.length} 個待復查，但未配置 ZAI_API_KEY，無法派發。`;
    } else if (inFlight.length) {
      aiReviewStatus = 'in_flight';
      aiReviewSummary = `正在復查（GLM）：${inFlight.map((r) => r.taskId).join(', ')}。這不是 Cursor/Pi Runner，請等日誌出現「已通過／退回／失敗」。`;
    } else if (onCooldown.length && !ready.length) {
      aiReviewStatus = 'cooldown';
      const sec = Math.ceil(Math.max(...onCooldown.map((r) => r.cooldownRemainingMs)) / 1000);
      aiReviewSummary = `復查未在執行；冷卻中約 ${sec}s（任務 ${onCooldown.map((r) => r.taskId).join(', ')}）。點「推進一步」可立即重試。`;
    } else {
      aiReviewStatus = 'idle_pending';
      aiReviewSummary = `復查未在執行，尚有待派發：${ready.map((r) => r.taskId).join(', ') || pendingAi.map((r) => r.taskId).join(', ')}。請點「推進一步」。`;
    }
  }

  return {
    runId: run.id,
    projectId,
    goal: run.goal,
    status: run.status,
    phase: run.phase,
    threadId: run.thread_id,
    modelConfigured,
    blockedReason,
    blockedHint: BLOCKED_HINTS[blockedReason],
    graph,
    taskMatrix,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      reviewerType: t.review?.reviewer_type ?? null,
      reviewStatus: t.review?.status ?? null,
      humanReviewed: Boolean(t.human_reviewed),
      pendingReview: isPendingReview(t as Parameters<typeof isPendingReview>[0]),
    })),
    aiReviews: pendingAi,
    aiReviewActivity: {
      status: aiReviewStatus,
      summary: aiReviewSummary,
      inFlightCount: inFlight.length,
      cooldownCount: onCooldown.length,
      readyCount: ready.length,
      pendingCount: pendingAi.length,
    },
    runner: {
      provider: runner.provider,
      source: runner.source,
      configured: runner.configured,
      ready: runner.ready,
      activeCount: activeJobs.length,
      jobs: jobs.slice(0, 20).map((j) => ({
        id: j.id,
        taskId: j.taskId,
        status: j.status,
        provider: j.provider ?? null,
        agentName: j.agentName,
        error: j.error ?? null,
        updatedAt: j.updatedAt,
      })),
    },
    openDecisions: openDecisions.map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status,
    })),
    checkpoint: pickCheckpointSummary(cp),
    events: listRunEvents(runId, { limit: 80 }),
    generatedAt: new Date().toISOString(),
  };
}

export type RunDebugSnapshot = Awaited<ReturnType<typeof getRunDebugSnapshot>>;
