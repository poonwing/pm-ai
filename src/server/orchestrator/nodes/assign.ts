import { appendRunMessage } from '../../services/auto.js';
import { createTask, getProject } from '../../services/tasks.js';
import { listStaffAgents } from '../../services/agents.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';
import {
  createdTaskIdsFromCheckpoint,
  dispatchFromCheckpoint,
  readyPlanTasks,
  type DispatchCheckpoint,
  type PlanTask,
} from '../helpers.js';

async function enqueuePlanTask(input: {
  state: OrchestratorStateType;
  planTask: PlanTask;
  roleMap: Map<string, { id: string; name: string }>;
  assignable: Array<{ id: string; name: string; role: string }>;
  projectGitRoot: string | null | undefined;
  dispatch: DispatchCheckpoint;
}): Promise<{ taskId: string | null; dispatch: DispatchCheckpoint }> {
  const { state, planTask: t, roleMap, assignable, projectGitRoot } = input;
  let dispatch = { ...input.dispatch, task_map: { ...input.dispatch.task_map }, enqueued: [...input.dispatch.enqueued] };

  let taskId = dispatch.task_map[t.id];
  if (!taskId) {
    const assignee = roleMap.get(t.role) ?? assignable[0];
    if (!assignee) {
      appendRunMessage(state.runId, 'assistant', `無可用 assignable 員工，跳過任務：${t.title}`);
      return { taskId: null, dispatch };
    }
    const task = createTask(
      state.projectId,
      {
        title: t.title,
        goal: t.goal,
        acceptance_criteria: t.acceptance_criteria,
        agent_name: 'orchestrator',
        agent_notes: `plan_task_id=${t.id}${t.depends_on.length ? `; depends_on=${t.depends_on.join(',')}` : ''}`,
        use_isolation: Boolean(projectGitRoot),
        assignee_agent_id: assignee.id,
        assignee_name: assignee.name,
        queue_order: t.queue_order,
        review: {
          required: t.reviewer_type !== 'none',
          reviewer_type: t.reviewer_type,
          reviewer_agent_id:
            t.reviewer_type === 'agent' ? (roleMap.get('reviewer')?.id ?? null) : null,
          status: 'none',
          note: '',
        },
      },
      'agent',
    );
    taskId = task.id;
    dispatch.task_map[t.id] = taskId;
    appendRunMessage(
      state.runId,
      'assistant',
      `已建立 ${taskId}（plan:${t.id}）→ ${assignee.name}` +
        (t.depends_on.length ? `，依賴 [${t.depends_on.join(', ')}]` : '') +
        (t.reviewer_type === 'agent'
          ? `，審查者 ${roleMap.get('reviewer')?.name ?? '協調者備援'}`
          : t.reviewer_type === 'orchestrator'
            ? '，由協調者復查'
            : t.reviewer_type === 'none'
              ? '，無需人類驗收'
              : '，需人類驗收'),
    );
  }

  if (!dispatch.enqueued.includes(t.id)) {
    const { enqueueRunnerJob } = await import('../../runner/index.js');
    enqueueRunnerJob({
      projectId: state.projectId,
      taskId,
      autoRunId: state.runId,
    });
    dispatch.enqueued.push(t.id);
    appendRunMessage(state.runId, 'assistant', `已提交 Runner：${taskId}（wave 任務 ${t.id}）`);
  }

  return { taskId, dispatch };
}

export async function assignNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const plan = state.plan;
  const project = getProject(state.projectId);
  if (!plan) {
    const next = { ...state, phase: 'wait_events', status: 'running' };
    syncRunMirror(next);
    return { phase: 'wait_events', status: 'running' };
  }

  const assignable = listStaffAgents(state.projectId, { assignableOnly: true });
  const roleMap = new Map(assignable.map((a) => [a.role, a]));
  let dispatch = dispatchFromCheckpoint(state.checkpoint);
  const ready = readyPlanTasks(plan, dispatch, state.projectId);

  if (!ready.length && !Object.keys(dispatch.task_map).length && !(plan.tasks?.length)) {
    const next = { ...state, phase: 'completed', status: 'completed' };
    syncRunMirror(next);
    return { phase: 'completed', status: 'completed' };
  }

  if (!ready.length) {
    appendRunMessage(
      state.runId,
      'assistant',
      Object.keys(dispatch.task_map).length
        ? '本波無可派發任務（等待依賴完成或人類驗收）。'
        : '尚無可立即執行的任務（可能皆有未滿足依賴）。',
    );
    const checkpoint = { ...state.checkpoint, plan, dispatch };
    const next = { ...state, phase: 'wait_events', status: 'running', checkpoint };
    syncRunMirror(next);
    return { phase: 'wait_events', status: 'running', checkpoint };
  }

  const createdTaskIds = new Set(createdTaskIdsFromCheckpoint(state.checkpoint));
  let waveCount = 0;

  for (const t of ready) {
    const result = await enqueuePlanTask({
      state,
      planTask: t,
      roleMap,
      assignable,
      projectGitRoot: project.gitRoot,
      dispatch,
    });
    dispatch = result.dispatch;
    if (result.taskId) {
      createdTaskIds.add(result.taskId);
      waveCount += 1;
    }
  }

  if (waveCount > 0) {
    dispatch = { ...dispatch, waves_done: dispatch.waves_done + 1 };
  }

  const createdTaskIdsArr = [...createdTaskIds];
  const checkpoint = {
    ...state.checkpoint,
    plan,
    dispatch,
    created_task_ids: createdTaskIdsArr,
  };

  const { resolveRunnerProvider } = await import('../../runner/index.js');
  appendRunMessage(
    state.runId,
    'assistant',
    waveCount
      ? `第 ${dispatch.waves_done} 波已派發 ${waveCount} 個任務（Runner: ${resolveRunnerProvider(state.projectId)}）。其餘任務待依賴完成後再派。`
      : '本波未新建任務。',
  );

  const next = {
    ...state,
    phase: 'wait_events',
    status: 'running',
    checkpoint,
    createdTaskIds: createdTaskIdsArr,
  };
  syncRunMirror(next);
  return {
    phase: 'wait_events',
    status: 'running',
    checkpoint,
    createdTaskIds: createdTaskIdsArr,
  };
}
