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
  getInbox,
  listProjectTasks,
  updateProject,
  ValidationError,
} from '../services/tasks.js';
import { getRunnerStatus } from '../runner/index.js';
import { isPendingReview } from '../../shared/schemas.js';
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
  isExplicitReplanRequest,
  isResearchPhase,
  isRetryRunnerRequest,
  isStartWorkRequest,
  isWaitingPhase,
  markClarifiedAndContinue,
  tryParseDecisionReply,
  type OrchestratorPlan,
} from './helpers.js';
import { reconcileRunnerFailures } from './nodes/reconcile-runner.js';
import { advanceResearchIfTaskDone } from './nodes/research.js';

export type { OrchestratorPhase } from './helpers.js';

/** Per-run tick mutex: serialize concurrent graph invokes on the same thread. */
const tickChains = new Map<string, Promise<unknown>>();

export type TickOptions = {
  forceReplan?: boolean;
  skipClarify?: boolean;
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
  if (opts.forceReplan) return { type: 'force_replan' };
  if (opts.skipClarify) return { type: 'skip_clarify' };
  return { type: 'tick' };
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

  if (userClarifyTurn) {
    return new Command({
      goto: 'clarify' as const,
      update: { ...hydrated, pendingCommand: null, status: 'running' },
    });
  }

  // Research Runner finished but graph may still be parked at END after interrupt.
  if (!researchDone && researchTaskId) {
    return new Command({
      ...(pendingInterrupt ? { resume: null } : { goto: 'research' as const }),
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
      ...(pendingInterrupt ? { resume: null } : { goto: 'clarify' as const }),
      update,
    });
  }

  if (pendingInterrupt) {
    return new Command({ resume: null, update });
  }

  return new Command({ update });
}

async function runGraphUnlocked(
  runId: string,
  command?: PendingCommand,
): Promise<TickResult> {
  let run = getAutoRun(runId);
  if (run.status === 'stopped' || run.status === 'paused' || run.status === 'completed') {
    return runResult(runId);
  }

  await advanceResearchIfTaskDone(runId);
  run = getAutoRun(runId);

  const graph = getCompiledOrchestratorGraph();
  const config = { configurable: { thread_id: run.thread_id } };
  const snapshot = await graph.getState(config);
  const hasGraphState = Boolean(snapshot.values?.runId);
  const pendingInterrupt = graphHasPendingInterrupt(snapshot);
  const graphValues = snapshot.values as Partial<OrchestratorStateType> | undefined;

  if (!hasGraphState) {
    const initial = mergeRunIntoState(run);
    if (command) initial.pendingCommand = command;
    await graph.invoke(initial, config);
    return runResult(runId, {
      decisions: listDecisions(run.project_id, 'open').filter((d) => d.run_id === runId),
      tasks: createdTaskIdsFromCheckpoint(getAutoRun(runId).checkpoint),
    });
  }

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

  const latest = getAutoRun(runId);
  return runResult(runId, {
    decisions: listDecisions(latest.project_id, 'open').filter((d) => d.run_id === runId),
    tasks: createdTaskIdsFromCheckpoint(latest.checkpoint),
  });
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
  updateProject(projectId, { run_mode: 'auto' });
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
      '偵測到你要求立刻開工：先做 workspace 研究，完成後將跳過需求澄清，進入審查協定與規劃。',
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
        '已記下。研究員完成後將跳過澄清，直接進入審查協定與規劃。',
      );
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
        '需求對齊結束，開始進入審查協定與規劃…',
        appendRunMessage,
        updateAutoRun,
        getAutoRun,
      );
      return tickOrchestrator(runId, { skipClarify: true });
    }
    return runGraph(runId, { type: 'user_message', text: message });
  }

  latest = getAutoRun(runId);

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
          `有待處理任務 ${pending.map((t) => t.id).join(', ')}，但未能提交 Runner。請確認 Runner 已配置（CURSOR_API_KEY 或 OpenCode），或到任務詳情手動操作。`,
        );
      }
    }
    return runGraph(runId, { type: 'retry_runner' });
  }

  if (isWaitingPhase(latest.phase)) {
    if (isExplicitReplanRequest(message)) {
      appendRunMessage(runId, 'assistant', '收到，將依你的補充重新規劃與分派…');
      return tickOrchestrator(runId, { forceReplan: true });
    }
    appendRunMessage(
      runId,
      'assistant',
      '已記下補充指示（任務仍在執行中，不會自動重規劃）。若要依新指示重新規劃，請回覆「重新規劃」，或點「推進一步」查看進度彙總。',
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
    updateAutoRun(d.run_id, { phase: 'plan', status: 'running' });
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
  const tasks = listProjectTasks(projectId);
  const inbox = getInbox().filter((t) => t.projectId === projectId || t.project_id === projectId);
  const done = tasks.filter((t) => t.status === 'done');
  const pendingReview = done.filter((t) =>
    isPendingReview(t as Parameters<typeof isPendingReview>[0]),
  );
  const pendingAi = pendingReview.filter(
    (t) => t.review?.reviewer_type === 'agent' || t.review?.reviewer_type === 'orchestrator',
  );
  const pendingHuman = pendingReview.filter(
    (t) => !t.review || t.review.reviewer_type === 'human',
  );
  const summary = `進度：共 ${tasks.length} 任務，完成 ${done.length}，待 AI 復查 ${pendingAi.length}，待人驗收 ${pendingHuman.length}，inbox ${inbox.length}`;
  appendRunMessage(runId, 'assistant', summary);
  if (tasks.length && done.length === tasks.length && pendingReview.length === 0) {
    updateAutoRun(runId, { status: 'completed', phase: 'completed' });
  }
  return getAutoRun(runId);
}

export { reconcileRunnerFailures };
