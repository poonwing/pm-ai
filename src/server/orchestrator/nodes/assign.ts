import { appendRunMessage } from '../../services/auto.js';
import { createTask, getProject } from '../../services/tasks.js';
import { listStaffAgents } from '../../services/agents.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';

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
  const createdTaskIds: string[] = [];

  for (const t of plan.tasks ?? []) {
    const assignee = roleMap.get(t.role) ?? assignable[0];
    if (!assignee) {
      appendRunMessage(state.runId, 'assistant', `無可用 assignable 員工，跳過任務：${t.title}`);
      continue;
    }
    const task = createTask(
      state.projectId,
      {
        title: t.title,
        goal: t.goal,
        acceptance_criteria: t.acceptance_criteria,
        agent_name: 'orchestrator',
        use_isolation: Boolean(project.gitRoot),
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
    createdTaskIds.push(task.id);
    appendRunMessage(
      state.runId,
      'assistant',
      `已分派 ${task.id} → ${assignee.name}（序 ${t.queue_order}）` +
        (t.reviewer_type === 'agent'
          ? `，審查者 ${roleMap.get('reviewer')?.name ?? '協調者備援'}`
          : t.reviewer_type === 'orchestrator'
            ? '，由協調者復查'
            : ''),
    );
    const { enqueueRunnerJob } = await import('../../runner/index.js');
    enqueueRunnerJob({
      projectId: state.projectId,
      taskId: task.id,
      autoRunId: state.runId,
    });
  }

  const checkpoint = {
    ...state.checkpoint,
    plan,
    created_task_ids: createdTaskIds,
  };

  appendRunMessage(
    state.runId,
    'assistant',
    createdTaskIds.length
      ? `已建立 ${createdTaskIds.length} 個任務，並提交 Runner（${process.env.RUNNER_PROVIDER ?? 'cursor'}）自動執行。完成後我會彙總；你也可隨時喊停。`
      : '尚未建立任務。請補充需求或確認有 assignable 員工。',
  );

  let status = 'running';
  let phase = 'wait_events';
  if (!createdTaskIds.length && !(plan.tasks?.length)) {
    status = 'completed';
    phase = 'completed';
  }

  const next = { ...state, phase, status, checkpoint, createdTaskIds };
  syncRunMirror(next);
  return { phase, status, checkpoint, createdTaskIds };
}
