import { appendRunMessage, createMeeting } from '../../services/auto.js';
import { listStaffAgents } from '../../services/agents.js';
import { chatCompletion, isModelConfigured } from '../model.js';
import type { OrchestratorStateType } from '../state.js';
import { syncRunMirror } from '../sync.js';

export async function meetingNode(
  state: OrchestratorStateType,
): Promise<Partial<OrchestratorStateType>> {
  const plan = state.plan;
  if (!plan?.need_meeting || !plan.meeting_topic) return {};

  const staff = listStaffAgents(state.projectId, { assignableOnly: true });
  const participants = staff.slice(0, 3);
  const messages = [];
  for (const s of participants) {
    let content = `從 ${s.role} 角度：建議推進「${state.goal}」。`;
    if (isModelConfigured()) {
      try {
        content = await chatCompletion([
          { role: 'system', content: s.system_prompt },
          {
            role: 'user',
            content: `會議主題：${plan.meeting_topic}\n專案目標：${state.goal}\n請用 2-4 句給出專業意見。`,
          },
        ]);
      } catch {
        /* keep fallback */
      }
    }
    messages.push({
      agentId: s.id,
      agentName: s.name,
      role: s.role,
      content,
    });
  }

  const meeting = createMeeting({
    projectId: state.projectId,
    runId: state.runId,
    topic: plan.meeting_topic,
    participantIds: participants.map((p) => p.id),
    messages,
    summary: `會議「${plan.meeting_topic}」結束，繼續執行計劃。`,
  });
  appendRunMessage(state.runId, 'assistant', `已召開會議：${meeting.topic}`);

  const next = { ...state, phase: 'meeting' };
  syncRunMirror(next);
  return { phase: 'meeting' };
}
