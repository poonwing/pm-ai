import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  workspacePath: text('workspace_path').notNull().unique(),
  description: text('description').default(''),
  bindingStatus: text('binding_status').notNull().default('ok'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  gitRoot: text('git_root'),
  createdAt: text('created_at').notNull(),
  lastOpenedAt: text('last_opened_at'),
  pathLastSeenAt: text('path_last_seen_at'),
});

export const tasks = sqliteTable('tasks', {
  uid: text('uid').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  id: text('id').notNull(),
  relPath: text('rel_path').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  version: integer('version').notNull(),
  humanReviewed: integer('human_reviewed', { mode: 'boolean' }).notNull().default(false),
  claimedBy: text('claimed_by'),
  claimedAt: text('claimed_at'),
  contentHash: text('content_hash'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
});

export const leases = sqliteTable('leases', {
  taskUid: text('task_uid')
    .primaryKey()
    .references(() => tasks.uid),
  agentName: text('agent_name').notNull(),
  leaseToken: text('lease_token').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  taskId: text('task_id').notNull(),
  at: text('at').notNull(),
  actor: text('actor').notNull(),
  actorName: text('actor_name'),
  body: text('body').notNull(),
});

export const activityLogs = sqliteTable('activity_logs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  taskId: text('task_id').notNull(),
  at: text('at').notNull(),
  actor: text('actor').notNull(),
  actorName: text('actor_name'),
  action: text('action').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  summary: text('summary'),
  body: text('body'),
});

export const previewServers = sqliteTable('preview_servers', {
  taskUid: text('task_uid').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  taskId: text('task_id').notNull(),
  status: text('status').notNull().default('stopped'),
  port: integer('port'),
  pid: integer('pid'),
  cwd: text('cwd'),
  command: text('command'),
  logTail: text('log_tail').default('[]'),
  error: text('error'),
  startedAt: text('started_at'),
  updatedAt: text('updated_at').notNull(),
});

export const staffAgents = sqliteTable('staff_agents', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  name: text('name').notNull(),
  role: text('role').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  skillsTags: text('skills_tags').notNull().default('[]'),
  status: text('status').notNull().default('idle'),
  assignable: integer('assignable', { mode: 'boolean' }).notNull().default(false),
  createdBy: text('created_by').notNull(),
  promptSource: text('prompt_source').notNull(),
  creationRationale: text('creation_rationale'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const autoRuns = sqliteTable('auto_runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  goal: text('goal').notNull(),
  status: text('status').notNull().default('running'),
  phase: text('phase').notNull().default('intake'),
  threadId: text('thread_id').notNull(),
  checkpointJson: text('checkpoint_json').default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const autoRunMessages = sqliteTable('auto_run_messages', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => autoRuns.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  at: text('at').notNull(),
});

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  runId: text('run_id').references(() => autoRuns.id),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  optionsJson: text('options_json').notNull().default('[]'),
  recommendedOptionId: text('recommended_option_id'),
  chosenOptionId: text('chosen_option_id'),
  status: text('status').notNull().default('open'),
  note: text('note'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const meetings = sqliteTable('meetings', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  runId: text('run_id').references(() => autoRuns.id),
  topic: text('topic').notNull(),
  participantIdsJson: text('participant_ids_json').notNull().default('[]'),
  summary: text('summary').default(''),
  escalatedToDecisionId: text('escalated_to_decision_id'),
  createdAt: text('created_at').notNull(),
});

export const meetingMessages = sqliteTable('meeting_messages', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id')
    .notNull()
    .references(() => meetings.id),
  agentId: text('agent_id'),
  agentName: text('agent_name'),
  role: text('role').notNull(),
  content: text('content').notNull(),
  at: text('at').notNull(),
});

export const reviewPolicies = sqliteTable('review_policies', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id),
  version: integer('version').notNull().default(1),
  policyJson: text('policy_json').notNull(),
  confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(false),
  confirmedAt: text('confirmed_at'),
  updatedAt: text('updated_at').notNull(),
});

export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  title: text('title').notNull().default('新對話'),
  mode: text('mode').notNull().default('ask'),
  status: text('status').notNull().default('idle'),
  provider: text('provider'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => chatSessions.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  kind: text('kind').notNull().default('text'),
  at: text('at').notNull(),
});
