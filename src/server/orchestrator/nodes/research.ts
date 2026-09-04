import { appendRunMessage, getAutoRun, updateAutoRun } from '../../services/auto.js';
import { ensureDefaultStaffAgents, listStaffAgents } from '../../services/agents.js';
import { createTask, getProject, getTask } from '../../services/tasks.js';
import { getRunnerStatus, isRunnerConfigured } from '../../runner/index.js';
import { interrupt } from '@langchain/langgraph';
import {
  RESEARCH_ACCEPTANCE,
  RESEARCH_CONSTRAINTS,
  collectWorkspaceBrief,
  summarizeResearchForGoal,
} from '../research.js';
import type { OrchestratorStateType } from '../state.js';
import { buildInitialGraphState } from '../state.js';
import { syncRunMirror } from '../sync.js';
import { checkpointFlag, isClarified } from '../helpers.js';

function mergeCheckpointFromRun(state: OrchestratorStateType): OrchestratorStateType {
  const run = getAutoRun(state.runId);
  const dbCp = run.checkpoint ?? {};
  return {
    ...state,
    checkpoint: { ...state.checkpoint, ...dbCp },
    phase: run.phase || state.phase,
    status: run.status || state.status,
  };
}

async function finishResearchState(
  state: OrchestratorStateType,
  report: string,
  source: 'runner' | 'local' | 'fallback',
): Promise<Partial<OrchestratorStateType>> {
  const trimmed = report.trim().slice(0, 8000);
  const skip = checkpointFlag(state.checkpoint, 'skip_clarify_after_research');
  const checkpoint = {
    ...state.checkpoint,
    research_done: true,
    research_source: source,
    research_report: trimmed,
    research_finished_at: new Date().toISOString(),
    ...(skip ? { clarified: true, clarified_at: new Date().toISOString() } : {}),
  };
  const next = {
    ...state,
    status: 'running',
    phase: skip ? 'design' : 'clarify',
    checkpoint,
  };
  syncRunMirror(next);
  appendRunMessage(
    state.runId,
    'assistant',
    source === 'runner'
      ? `研究員已完成 workspace 分析，接下來會基於研究結果澄清／規劃。\n\n—— 研究摘要 ——\n${trimmed.slice(0, 2500)}${trimmed.length > 2500 ? '\n…' : ''}`
      : `已完成 workspace 快速研究（${source}），接下來會基於結果澄清／規劃。\n\n—— 研究摘要 ——\n${trimmed.slice(0, 2500)}${trimmed.length > 2500 ? '\n…' : ''}`,
  );
  return { status: next.status, phase: next.phase, checkpoint };
}

/** Pause until Runner completes; on resume, re-enter and poll task status. */
async function waitForResearchTask(
  state: OrchestratorStateType,
  researchTaskId: string,
): Promise<Partial<OrchestratorStateType>> {
  const waiting = { ...state, phase: 'research', status: 'running' };
  syncRunMirror(waiting);
  interrupt({ reason: 'research', taskId: researchTaskId });
  return researchNode(mergeCheckpointFromRun(state));
}

export async function researchNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  state = mergeCheckpointFromRun(state);
  if (checkpointFlag(state.checkpoint, 'research_done')) {
    const skip =
      state.skipClarify ||
      checkpointFlag(state.checkpoint, 'skip_clarify_after_research') ||
      isClarified(state.checkpoint);
    const phase = skip ? 'design' : 'clarify';
    // Propagate checkpoint/phase so routeAfterResearch does not see a stale graph state.
    return {
      status: 'running',
      phase,
      checkpoint: state.checkpoint,
      skipClarify: skip,
    };
  }

  const project = getProject(state.projectId);
  ensureDefaultStaffAgents(state.projectId);

  const researchTaskId =
    typeof state.checkpoint.research_task_id === 'string'
      ? state.checkpoint.research_task_id
      : null;

  if (researchTaskId) {
    try {
      const task = getTask(state.projectId, researchTaskId);
      if (task.status === 'done') {
        const note = String(task.result_note ?? '').trim();
        const report =
          note ||
          (await summarizeResearchForGoal(
            collectWorkspaceBrief(project.workspacePath),
            state.goal,
            project.name,
            project.description ?? '',
          ));
        return finishResearchState(state, report, note ? 'runner' : 'fallback');
      }

      const jobs = getRunnerStatus(state.projectId).jobs.filter((j) => j.taskId === researchTaskId);
      const terminal = jobs.find((j) => j.status === 'failed' || j.status === 'cancelled');
      if (terminal) {
        const brief = collectWorkspaceBrief(project.workspacePath);
        const report = await summarizeResearchForGoal(
          brief,
          state.goal,
          project.name,
          project.description ?? '',
        );
        return finishResearchState(
          state,
          `${report}\n\n（Runner 研究任務 ${terminal.status}：${terminal.error ?? ''}）`,
          'fallback',
        );
      }

      return waitForResearchTask(state, researchTaskId);
    } catch {
      if (researchTaskId) {
        return waitForResearchTask(state, researchTaskId);
      }
    }
  }

  if (!isRunnerConfigured()) {
    appendRunMessage(state.runId, 'assistant', 'Runner 未配置，改以本機快照做快速研究（只讀）…');
    const brief = collectWorkspaceBrief(project.workspacePath);
    const report = await summarizeResearchForGoal(
      brief,
      state.goal,
      project.name,
      project.description ?? '',
    );
    return finishResearchState(state, report, 'local');
  }

  const researchers = listStaffAgents(state.projectId, { assignableOnly: true }).filter(
    (a) => a.role === 'researcher',
  );
  const researcher = researchers[0];
  if (!researcher) {
    const brief = collectWorkspaceBrief(project.workspacePath);
    const report = await summarizeResearchForGoal(
      brief,
      state.goal,
      project.name,
      project.description ?? '',
    );
    return finishResearchState(state, report, 'local');
  }

  const task = createTask(
    state.projectId,
    {
      title: `研究：${state.goal.slice(0, 48)}`,
      goal: [
        `針對用戶需求做 workspace 只讀分析。`,
        `需求：${state.goal}`,
        project.description ? `專案描述：${project.description}` : '',
        `工作目錄：${project.workspacePath}`,
        `請產出結構化研究報告（見員工人設），供協調者澄清與規劃。`,
      ]
        .filter(Boolean)
        .join('\n'),
      acceptance_criteria: RESEARCH_ACCEPTANCE,
      constraints: RESEARCH_CONSTRAINTS,
      agent_name: 'orchestrator',
      use_isolation: false,
      assignee_agent_id: researcher.id,
      assignee_name: researcher.name,
      queue_order: 0,
      review: {
        required: false,
        reviewer_type: 'none',
        reviewer_agent_id: null,
        status: 'none',
        note: '',
      },
    },
    'agent',
  );

  const { enqueueRunnerJob } = await import('../../runner/index.js');
  const job = enqueueRunnerJob({
    projectId: state.projectId,
    taskId: task.id,
    autoRunId: state.runId,
  });

  if (job.status === 'failed') {
    const brief = collectWorkspaceBrief(project.workspacePath);
    const report = await summarizeResearchForGoal(
      brief,
      state.goal,
      project.name,
      project.description ?? '',
    );
    return finishResearchState(
      state,
      `${report}\n\n（Runner 未能啟動研究任務：${job.error ?? 'unknown'}）`,
      'fallback',
    );
  }

  const checkpoint = {
    ...state.checkpoint,
    research_task_id: task.id,
    research_started_at: new Date().toISOString(),
  };
  const next = { ...state, phase: 'research', status: 'running', checkpoint };
  syncRunMirror(next);
  updateAutoRun(state.runId, { phase: 'research', status: 'running', checkpoint });
  appendRunMessage(
    state.runId,
    'assistant',
    `已指派研究員「${researcher.name}」分析 workspace（任務 ${task.id}，只讀）。完成後我會帶著研究結果繼續澄清。`,
  );
  return waitForResearchTask({ ...state, checkpoint }, task.id);
}

/** If the research Runner task is done, mark research complete in auto_runs (图外可靠推进). */
export async function advanceResearchIfTaskDone(runId: string): Promise<boolean> {
  const run = getAutoRun(runId);
  const cp = run.checkpoint ?? {};
  if (checkpointFlag(cp, 'research_done')) return false;

  const researchTaskId =
    typeof cp.research_task_id === 'string' ? cp.research_task_id : null;
  if (!researchTaskId) return false;

  try {
    const project = getProject(run.project_id);
    const task = getTask(run.project_id, researchTaskId);
    if (task.status !== 'done') return false;

    const state = buildInitialGraphState({
      runId: run.id,
      projectId: run.project_id,
      goal: run.goal,
      checkpoint: cp,
      skipClarify: checkpointFlag(cp, 'skip_clarify_after_research'),
    });
    Object.assign(state, {
      phase: run.phase,
      status: run.status,
      skipClarify:
        state.skipClarify ||
        checkpointFlag(cp, 'skip_clarify_after_research') ||
        checkpointFlag(cp, 'clarified'),
    });

    const note = String(task.result_note ?? '').trim();
    const report =
      note ||
      (await summarizeResearchForGoal(
        collectWorkspaceBrief(project.workspacePath),
        run.goal,
        project.name,
        project.description ?? '',
      ));
    await finishResearchState(state, report, note ? 'runner' : 'fallback');
    return true;
  } catch {
    return false;
  }
}
