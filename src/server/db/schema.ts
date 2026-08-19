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
