import { Command } from '@langchain/langgraph';
import {
  appendRunMessage,
  createAutoRun,
  getAutoRun,
  listDecisions,
  resolveDecision,
  stopAutoRun,
  updateAutoRun,
  upsertReviewPolicy,
} from '../services/auto.js';
import { ensureDefaultStaffAgents } from '../services/agents.js';
import {
  listProjectTasks,
  ValidationError,
} from '../services/tasks.js';
import { getRunnerStatus } from '../runner/index.js';
import { getCompiledOrchestratorGraph } from './graph.js';
import {
  buildInitialGraphState,
  type OrchestratorStateType,
  type PendingCommand,
} from './state.js';
import { runResult, type TickResult, hydrateStateFromRun, graphHasPendingInterrupt } from './sync.js';
import {
  checkpointFlag,
  createdTaskIdsFromCheckpoint,
  decisionChatHint,
  isClarified,
  isClarifyPhase,
  isDesignDone,
  isDesignPhase,
  isExplicitReplanRequest,
  isRequirementChangeRequest,
  isResearchPhase,
  isRetryRunnerRequest,
  isStartWorkRequest,
  isStatusInquiry,
  isWaitingPhase,
  markClarifiedAndContinue,
  REQUIREMENT_CHANGE_DECISION_TITLE,
  tryParseDecisionReply,
  collectRunTaskIds,
  evaluateRunProgress,
  type OrchestratorPlan,
} from './helpers.js';
import { reconcileRunnerFailures } from './nodes/reconcile-runner.js';
import { advanceResearchIfTaskDone } from './nodes/research.js';
import {
  applyRequirementChangeDecision,
  cancelRunOpenWork,
  openRequirementChangeDecision,
} from './replan.js';

export type { OrchestratorPhase } from './helpers.js';

/** Per-run tick mutex: serialize concurrent graph invokes on the same thread. */
const tickChains = new Map<string, Promise<unknown>>();

export type TickOptions = {
  forceReplan?: boolean;
  skipClarify?: boolean;
  forceRedesign?: boolean;
};

function stateFromRun(run: ReturnType<typeof getAutoRun>) {
  const checkpoint = run.checkpoint ?? {};
  return buildInitialGraphState({
    runId: run.id,
    projectId: run.project_id,
    goal: run.goal,
    checkpoint,
    skipClarify: checkpointFlag(checkpoint, 'skip_clarify_after_research'),
  });
}

function mergeRunIntoState(run: ReturnType<typeof getAutoRun>) {
  const base = stateFromRun(run);
  const cp = run.checkpoint ?? {};
  const plan = cp.plan as OrchestratorPlan | undefined;
  return {
    ...base,
    phase: run.phase,
    status: run.status,
    plan: plan ?? null,
    createdTaskIds: createdTaskIdsFromCheckpoint(run.checkpoint),
    skipClarify:
      base.skipClarify ||
      checkpointFlag(run.checkpoint, 'skip_clarify_after_research') ||
      isClarified(run.checkpoint),
  };
}

function optsToCommand(opts: TickOptions): PendingCommand | undefined {
  if (opts.forceRedesign) return { type: 'force_redesign' };
  if (opts.forceReplan) return { type: 'force_replan' };
  if (opts.skipClarify) return { type: 'skip_clarify' };
  return { type: 'tick' };
}

function buildRunStatusSummary(projectId: string, runId: string): string {
  const run = getAutoRun(runId);
  const runTaskIds = new Set(collectRunTaskIds(run));
  const tasks = listProjectTasks(projectId).filter((t) => runTaskIds.has(t.id));
  const jobs = getRunnerStatus(projectId).jobs.filter(
    (j) =>
      j.kind !== 'studio' &&
      (j.autoRunId === runId || (runTaskIds.has(j.taskId) && !j.autoRunId)),
  );
  const activeJobs = jobs.filter((j) =>
    ['queued', 'claiming', 'running'].includes(j.status),
  );
  const runningJobs = jobs.filter((j) => j.status === 'running');
  const inProgress = tasks.filter((t) => t.status === 'in_progress');
  const todo = tasks.filter((t) => t.status === 'todo');
  const done = tasks.filter((t) => t.status === 'done');

  const agentNames = new Set<string>();
  for (const j of runningJobs) {
    if (j.agentName) agentNames.add(j.agentName);
  }
  for (const t of inProgress) {
    const name = (t as { assignee_name?: string }).assignee_name;
    if (name) agentNames.add(name);
  }

  const lines = [
    `目前 ${runningJobs.length} 個 Runner 任務正在執行（含排隊/啟動共 ${activeJobs.length} 個）。`,
    `約 ${agentNames.size} 位 agent 參與中${agentNames.size ? `：${[...agentNames].join('、')}` : ''}。`,
    `本 Run 任務：完成 ${done.length}，進行中 ${inProgress.length}，待開始 ${todo.length}。`,
  ];
  if (activeJobs.length) {
    lines.push(
      `Runner：${activeJobs
        .map((j) => `${j.taskId}（${j.status} · ${j.agentName}）`)
        .join('；')}`,
    );
  } else if (!todo.length && !inProgress.length && done.length) {
    lines.push('目前沒有進行中的 Runner；可點「推進一步」查看彙總。');
  } else if (todo.length && !activeJobs.length) {
    lines.push(`有 ${todo.length} 個任務待 Runner 領取；若長時間無動靜可回覆「重試」。`);
  }
  lines.push('若要完整彙總請點「推進一步」；若要依新指示重規劃請回覆「重新規劃」。');
  return lines.join('\n');
}

function buildGraphInvokeCommand(input: {
  runId: string;
  run: ReturnType<typeof getAutoRun>;
  pendingCommand: PendingCommand;
  hydrated: Partial<OrchestratorStateType>;
  pendingInterrupt: boolean;
  userClarifyTurn: boolean;
}): Command {
  const { run, pendingCommand, hydrated, pendingInterrupt, userClarifyTurn } = input;
  const cp = run.checkpoint ?? {};
  const researchDone = checkpointFlag(cp, 'research_done');
  const researchTaskId =
    typeof cp.research_task_id === 'string' ? cp.research_task_id : null;
  const update = { ...hydrated, pendingCommand };
  // Prefer a concrete resume payload — some LangGraph versions treat `null` as "no resume".
  const resumePayload = { source: pendingCommand.type ?? 'tick' };

  if (userClarifyTurn) {
    return new Command({
      goto: 'clarify' as const,
      update: { ...hydrated, pendingCommand: null, status: 'running' },
    });
  }

  const userDesignTurn =
    pendingCommand.type === 'user_message' &&
    (run.phase === 'design' || (!isDesignDone(cp) && isClarified(cp)));

  if (userDesignTurn && isDesignPhase(run.phase)) {
    return new Command({
      goto: 'design' as const,
      update: { ...hydrated, pendingCommand, status: 'running' },
    });
  }

  // Research Runner finished but graph may still be parked at END after interrupt.
  if (!researchDone && researchTaskId) {
    return new Command({
      ...(pendingInterrupt ? { resume: resumePayload } : { goto: 'research' as const }),
      update,
    });
  }

  if (
    researchDone &&
    !isClarified(cp) &&
    !hydrated.skipClarify &&
    !checkpointFlag(cp, 'skip_clarify_after_research') &&
    (run.phase === 'clarify' || run.phase === 'intake')
  ) {
    return new Command({
      ...(pendingInterrupt ? { resume: resumePayload } : { goto: 'clarify' as const }),
      update,
    });
  }

  if (
    researchDone &&
    isClarified(cp) &&
    !isDesignDone(cp) &&
    (run.phase === 'design' || run.phase === 'agree_review_policy')
  ) {
    return new Command({
      ...(pendingInterrupt ? { resume: resumePayload } : { goto: 'design' as const }),
      update,
    });
  }

  if (checkpointFlag(cp, 'force_redesign')) {
    return new Command({
      ...(pendingInterrupt ? { resume: resumePayload } : { goto: 'design' as const }),
      update,
    });
  }

  if (pendingInterrupt) {
    return new Command({ resume: resumePayload, update });
  }

  // DB says we're waiting, but checkpoint has no interrupt (lost / undetected).
  // Force re-enter the execution loop so「推進一步」cannot no-op.
  const waitingPhase =
    run.phase === 'wait_events' ||
    run.phase === 'synthesize' ||
    isWaitingPhase(run.phase);
  const wantsAdvance =
    pendingCommand.type === 'tick' ||
    pendingCommand.type === 'task_event' ||
    pendingCommand.type === 'retry_runner' ||
    pendingCommand.type === 'decision_resolved';
  if (waitingPhase && wantsAdvance) {
    return new Command({
      goto: 'reconcileRunner' as const,
      update: { ...update, status: 'running' },
    });
  }

  return new Command({ update });
}

function tryCompleteRunIfIdle(runId: string, reason: string): boolean {
  const run = getAutoRun(runId);
  if (run.status === 'stopped' || run.status === 'completed') return false;

  // Only the post-dispatch execution loop may auto-complete.
  // Early phases (research/clarify/design/plan) often have zero open tasks and must not end.
  const phase = run.phase;
  if (
    phase !== 'wait_events' &&
    phase !== 'synthesize' &&
    phase !== 'assign'
  ) {
    return false;
  }

  // Design / plan not finished → still coordinating, never idle-complete.
  if (!isDesignDone(run.checkpoint)) return false;
  if (
    !createdTaskIdsFromCheckpoint(run.checkpoint).length &&
    !run.checkpoint.plan
  ) {
    return false;
  }

  const progress = evaluateRunProgress(run.project_id, runId);
  if (!progress.canComplete || !progress.scopedToRun) return false;

  const detail =
    progress.tasks.length === 0
      ? '沒有待辦任務'
      : `完成 ${progress.done.length}、取消 ${progress.cancelled.length}、待審 0`;
  appendRunMessage(runId, 'assistant', `${reason}（${detail}）。結束 Auto Run。`);
  appendRunEventSafe(runId, 'status_changed', 'system', `${reason} → completed`, {
    data: {
      done: progress.done.length,
      cancelled: progress.cancelled.length,
      scopedToRun: progress.scopedToRun,
    },
  });
  updateAutoRun(runId, { status: 'completed', phase: 'completed' });
  return true;
}

function appendRunEventSafe(
  runId: string,
  type: string,
  category: 'system' | 'graph',
  summary: string,
  opts?: { data?: Record<string, unknown> },
) {
  void import('../services/run-events.js')
    .then((m) =>
      m.appendRunEvent(runId, type, category, summary, { data: opts?.data }),
    )
    .catch(() => undefined);
}

async function runGraphUnlocked(
  runId: string,
  command?: PendingCommand,
): Promise<TickResult> {
  let run = getAutoRun(runId);
  if (run.status === 'stopped' || run.status === 'paused' || run.status === 'completed') {
    if (command?.type === 'tick') {
      appendRunMessage(
        runId,
        'system',
        `推進略過：Run 目前是 ${run.status}（已結束或暫停的 Run 不會再推進；請重新啟動）。`,
      );
    }
    return runResult(runId);
  }

  // Fast-path: all run work already terminal → complete without depending on graph resume.
  if (
    command?.type === 'tick' ||
    command?.type === 'retry_runner' ||
    (command?.type === 'task_event' &&
      (command.event === 'cancelled' || command.event === 'runner_completed'))
  ) {
    if (tryCompleteRunIfIdle(runId, '檢測到本 Run 已無未完成任務')) {
      return runResult(runId);
    }
  }

  if (command?.type === 'tick') {
    appendRunMessage(
      runId,
      'system',
      `收到「推進一步」（phase=${run.phase}）。正在喚醒編排…`,
    );
  }

  await advanceResearchIfTaskDone(runId);
  run = getAutoRun(runId);

  const graph = getCompiledOrchestratorGraph();
  const config = { configurable: { thread_id: run.thread_id } };
  const snapshot = await graph.getState(config);
  const hasGraphState = Boolean(snapshot.values?.runId);
  const pendingInterrupt = graphHasPendingInterrupt(snapshot);
  const graphValues = snapshot.values as Partial<OrchestratorStateType> | undefined;

  if (command?.type === 'tick') {
    appendRunEventSafe(runId, 'tick', 'system', '推進一步', {
      data: {
        phase: run.phase,
        pendingInterrupt,
        hasGraphState,
        next: Array.isArray(snapshot.next) ? snapshot.next : [],
      },
    });
  }

  try {
    if (!hasGraphState) {
      const initial = mergeRunIntoState(run);
      if (command) initial.pendingCommand = command;
      await graph.invoke(initial, config);
    } else {
      const hydrated = hydrateStateFromRun(runId, graphValues);
      const pendingCommand = command ?? { type: 'tick' as const };
      const userClarifyTurn = Boolean(
        command?.type === 'user_message' &&
          isClarifyPhase(run.phase) &&
          !isStartWorkRequest(command.text),
      );

      const input = buildGraphInvokeCommand({
        runId,
        run,
        pendingCommand,
        hydrated,
        pendingInterrupt,
        userClarifyTurn,
      });

      await graph.invoke(input as Parameters<typeof graph.invoke>[0], config);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendRunMessage(runId, 'system', `推進失敗：${msg}`);
    // Still try to complete if work is idle — graph errors should not strand the run.
    tryCompleteRunIfIdle(runId, '圖執行出錯，但任務已全部結束');
    throw err;
  }

  await forceDispatchAiReviewsAfterTick(runId, command);

  // Safety net after graph hop (e.g. synthesize didn't mark complete).
  if (command?.type === 'tick' || command?.type === 'task_event') {
    tryCompleteRunIfIdle(runId, '推進後確認本 Run 已無未完成任務');
  }

  const latest = getAutoRun(runId);
  if (command?.type === 'tick') {
    const progress = evaluateRunProgress(latest.project_id, runId);
    appendRunMessage(
      runId,
      'system',
      `推進完成：status=${latest.status} phase=${latest.phase}；${progress.summary}`,
    );
  }

  return runResult(runId, {
    decisions: listDecisions(latest.project_id, 'open').filter((d) => d.run_id === runId),
    tasks: createdTaskIdsFromCheckpoint(latest.checkpoint),
  });
}

async function forceDispatchAiReviewsAfterTick(
  runId: string,
  command?: PendingCommand,
) {
  // Explicit user actions only — avoids double-logging on every runner event.
  if (command?.type !== 'tick' && command?.type !== 'retry_runner') return;

  const { dispatchPendingAiReviews, formatDispatchAiReviewsResult } = await import(
    './ai-review.js'
  );
  const latestForReview = getAutoRun(runId);
  const result = dispatchPendingAiReviews(latestForReview.project_id, runId, {
    force: command.type === 'tick',
  });
  const summary = formatDispatchAiReviewsResult(result);
  if (summary) {
    appendRunMessage(runId, 'system', `[推進] ${summary}`);
    const { appendRunEvent } = await import('../services/run-events.js');
    appendRunEvent(runId, 'tick', 'system', `[推進] ${summary}`, {
      data: {
        started: result.started,
        skippedInFlight: result.skippedInFlight,
        skippedCooldown: result.skippedCooldown,
        pending: result.pending,
        modelMissing: result.modelMissing,
        force: command.type === 'tick',
      },
    });
  }
}

async function runGraph(runId: string, command?: PendingCommand): Promise<TickResult> {
  const prev = tickChains.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  tickChains.set(runId, chained);

  try {
    await prev.catch(() => undefined);
    return await runGraphUnlocked(runId, command);
  } finally {
    release();
    if (tickChains.get(runId) === chained) {
      tickChains.delete(runId);
    }
  }
}

export async function startOrchestratorRun(projectId: string, goal: string) {
  ensureDefaultStaffAgents(projectId);
  const run = createAutoRun(projectId, goal);
  if (isStartWorkRequest(goal)) {
    updateAutoRun(run.id, {
      checkpoint: {
        ...run.checkpoint,
        skip_clarify_after_research: true,
      },
    });
    appendRunMessage(
      run.id,
      'assistant',
      '偵測到你要求立刻開工：先做 workspace 研究，完成後將跳過需求澄清，進入設計與規劃。',
    );
    return tickOrchestrator(run.id, { skipClarify: true });
  }
  return tickOrchestrator(run.id);
}

export async function messageOrchestrator(runId: string, message: string) {
  const run = getAutoRun(runId);
  if (run.status === 'stopped' || run.status === 'completed') {
    throw new ValidationError('Run 已結束');
  }
  appendRunMessage(runId, 'user', message);
  if (run.status === 'paused') {
    updateAutoRun(runId, { status: 'running' });
  }

  let latest = getAutoRun(runId);
  const open = listDecisions(latest.project_id, 'open').filter((d) => d.run_id === runId);

  if (open.length) {
    const decision = [...open].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    const parsed = tryParseDecisionReply(decision.options, message);
    if (parsed) {
      resolveDecision(decision.id, parsed.optionId, parsed.note);
      appendRunMessage(runId, 'assistant', `已依對話完成決策「${decision.title}」，繼續推進。`);
      if (decision.title.includes('Review Policy')) {
        return handlePolicyDecision(decision.id, parsed.optionId);
      }
      if (decision.title.includes(REQUIREMENT_CHANGE_DECISION_TITLE)) {
        const action = await applyRequirementChangeDecision(runId, parsed.optionId);
        if (action === 'redesign') {
          return runGraph(runId, { type: 'force_redesign' });
        }
        if (action === 'replan') {
          return tickOrchestrator(runId, { forceReplan: true });
        }
        return tickOrchestrator(runId);
      }
      return tickOrchestrator(runId);
    }
    appendRunMessage(runId, 'assistant', decisionChatHint(decision.options));
    return runResult(runId, { decisions: open });
  }

  latest = getAutoRun(runId);

  if (
    isResearchPhase(latest.phase) ||
    (!checkpointFlag(latest.checkpoint, 'research_done') &&
      typeof latest.checkpoint.research_task_id === 'string')
  ) {
    if (isStartWorkRequest(message)) {
      updateAutoRun(runId, {
        checkpoint: {
          ...latest.checkpoint,
          skip_clarify_after_research: true,
        },
      });
      appendRunMessage(
        runId,
        'assistant',
        '已記下。研究員完成後將跳過澄清，直接進入設計與規劃。',
      );
    } else if (isStatusInquiry(message)) {
      appendRunMessage(runId, 'assistant', buildRunStatusSummary(latest.project_id, runId));
      return runResult(runId);
    } else {
      appendRunMessage(
        runId,
        'assistant',
        '研究員仍在分析 workspace，已記下你的補充；研究完成後會一併納入澄清／規劃。',
      );
    }
    return tickOrchestrator(runId, {
      skipClarify: checkpointFlag(getAutoRun(runId).checkpoint, 'skip_clarify_after_research'),
    });
  }

  if (!isClarified(latest.checkpoint) && isClarifyPhase(latest.phase)) {
    if (isStartWorkRequest(message)) {
      markClarifiedAndContinue(
        runId,
        '需求對齊結束，開始進入設計階段…',
        appendRunMessage,
        updateAutoRun,
        getAutoRun,
      );
      return tickOrchestrator(runId, { skipClarify: true });
    }
    return runGraph(runId, { type: 'user_message', text: message });
  }

  latest = getAutoRun(runId);

  if (isDesignPhase(latest.phase) || (!isDesignDone(latest.checkpoint) && isClarified(latest.checkpoint))) {
    return runGraph(runId, { type: 'user_message', text: message });
  }

  if (isRetryRunnerRequest(message)) {
    appendRunMessage(runId, 'assistant', '收到，正在重新提交失敗的 Runner 任務…');
    const requeued = await reconcileRunnerFailures(runId, { force: true });
    if (!requeued.length) {
      const pending = listProjectTasks(latest.project_id).filter(
        (t) => t.status === 'todo' || t.status === 'in_progress',
      );
      const activeJobs = getRunnerStatus(latest.project_id).jobs.filter(
        (j) => j.status === 'queued' || j.status === 'claiming' || j.status === 'running',
      );
      if (activeJobs.length) {
        appendRunMessage(
          runId,
          'assistant',
          `Runner 仍在執行中：${activeJobs.map((j) => j.taskId).join(', ')}。請稍候或停止 Auto Run 後再重試。`,
        );
      } else if (!pending.length) {
        appendRunMessage(runId, 'assistant', '沒有待處理任務（todo / in_progress）。');
      } else {
        appendRunMessage(
          runId,
          'assistant',
          `有待處理任務 ${pending.map((t) => t.id).join(', ')}，但未能提交 Runner。請確認 Runner 已配置（CURSOR_API_KEY 或 ZAI_API_KEY / Pi），或到任務詳情手動操作。`,
        );
      }
    }
    return runGraph(runId, { type: 'retry_runner' });
  }

  if (isWaitingPhase(latest.phase)) {
    if (isExplicitReplanRequest(message)) {
      appendRunMessage(runId, 'assistant', '收到，將取消未完成任務並依你的補充重新規劃與分派…');
      await cancelRunOpenWork(runId, { reason: '重新規劃：取消未完成任務' });
      return tickOrchestrator(runId, { forceReplan: true });
    }
    if (isStatusInquiry(message)) {
      appendRunMessage(runId, 'assistant', buildRunStatusSummary(latest.project_id, runId));
      return runResult(runId);
    }
    if (isRequirementChangeRequest(message)) {
      await openRequirementChangeDecision(runId, message);
      return runResult(runId);
    }
    appendRunMessage(
      runId,
      'assistant',
      '已記下補充指示（任務仍在執行中，不會自動重規劃）。若要改需求請直接說明變更點（會暫停並請你選擇處理方式），或回覆「重新規劃」／點「推進一步」。',
    );
    return runResult(runId);
  }

  return tickOrchestrator(runId);
}

export async function onDecisionResolved(decisionId: string) {
  const { getDecision } = await import('../services/auto.js');
  const d = getDecision(decisionId);
  if (d.run_id) {
    appendRunMessage(
      d.run_id,
      'system',
      `人類已選擇決策「${d.title}」選項：${d.chosen_option_id}`,
    );
    if (d.title.includes(REQUIREMENT_CHANGE_DECISION_TITLE) && d.chosen_option_id) {
      const action = await applyRequirementChangeDecision(d.run_id, d.chosen_option_id);
      if (action === 'redesign') {
        return runGraph(d.run_id, { type: 'force_redesign' });
      }
      if (action === 'replan') {
        return tickOrchestrator(d.run_id, { forceReplan: true });
      }
    }
    return tickOrchestrator(d.run_id);
  }
  return null;
}

export async function onTaskEvent(projectId: string, taskId: string, event: string) {
  const { listAutoRuns } = await import('../services/auto.js');
  const runs = listAutoRuns(projectId);
  const active = runs.find((r) => r.status === 'running' || r.status === 'awaiting_human');
  if (!active) return null;
  appendRunMessage(active.id, 'system', `任務事件 ${taskId}: ${event}`);

  const cp = active.checkpoint ?? {};
  const researchTaskId =
    typeof cp.research_task_id === 'string' ? cp.research_task_id : null;
  const inResearch =
    active.phase === 'research' ||
    (!checkpointFlag(cp, 'research_done') && researchTaskId !== null);
  const shouldResume =
    active.status === 'running' ||
    (inResearch && (taskId === researchTaskId || event === 'runner_completed'));

  if (shouldResume) {
    return runGraph(active.id, { type: 'task_event', taskId, event });
  }
  return active;
}

export async function tickOrchestrator(
  runId: string,
  opts: TickOptions = {},
): Promise<TickResult> {
  return runGraph(runId, optsToCommand(opts));
}

/** Alias for runner/ai-review callbacks that resume the graph after async work. */
export const resumeOrchestrator = tickOrchestrator;

export async function handlePolicyDecision(decisionId: string, chosenOptionId: string) {
  const { getDecision } = await import('../services/auto.js');
  const d = getDecision(decisionId);
  if (d.title.includes('Review Policy') && d.run_id) {
    if (chosenOptionId === 'human_only') {
      upsertReviewPolicy(
        d.project_id,
        { default_reviewer_type: 'human', human_verify_paths: ['**'] },
        true,
      );
    } else if (chosenOptionId === 'agent_default') {
      upsertReviewPolicy(d.project_id, { default_reviewer_type: 'agent' }, true);
    } else if (chosenOptionId === 'custom') {
      upsertReviewPolicy(
        d.project_id,
        {
          ...(d.note?.trim() ? { human_verify_notes: d.note.trim() } : {}),
          confirmed: true,
        },
        true,
      );
    } else {
      upsertReviewPolicy(d.project_id, {}, true);
    }
    updateAutoRun(d.run_id, { phase: 'design', status: 'running' });
  }
  return tickOrchestrator(d.run_id!);
}

export function requestStop(runId: string) {
  const run = stopAutoRun(runId);
  appendRunMessage(runId, 'system', '人類已停止 Auto Run');
  void import('../runner/index.js').then((m) => m.cancelForAutoRun(runId));
  void runGraph(runId, { type: 'stop' }).catch(() => undefined);
  return run;
}

export function synthesizeProgress(projectId: string, runId: string) {
  const progress = evaluateRunProgress(projectId, runId);
  appendRunMessage(runId, 'assistant', progress.summary);
  if (progress.canComplete) {
    updateAutoRun(runId, { status: 'completed', phase: 'completed' });
  }
  return getAutoRun(runId);
}

export { reconcileRunnerFailures };
export { getRunDebugSnapshot, type RunDebugSnapshot, type BlockedReason } from './debug.js';
