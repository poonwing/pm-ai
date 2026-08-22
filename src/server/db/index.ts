import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as schema from './schema.js';
import { getDbPath } from '../paths.js';
import { drizzle, migrate, openSqlite } from './sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function runMigrations(db: ReturnType<typeof drizzle<typeof schema>>) {
  const migrationsFolder = path.join(__dirname, 'migrations');
  if (fs.existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
    return;
  }
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_path TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      binding_status TEXT NOT NULL DEFAULT 'ok',
      archived INTEGER NOT NULL DEFAULT 0,
      git_root TEXT,
      created_at TEXT NOT NULL,
      last_opened_at TEXT,
      path_last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      uid TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      human_reviewed INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      claimed_at TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);
    CREATE TABLE IF NOT EXISTS leases (
      task_uid TEXT PRIMARY KEY REFERENCES tasks(uid),
      agent_name TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_name TEXT,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      summary TEXT,
      body TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_task ON activity_logs(task_id, at);
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_name TEXT,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id, at);
  `);
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS preview_servers (
      task_uid TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'stopped',
      port INTEGER,
      pid INTEGER,
      cwd TEXT,
      command TEXT,
      log_tail TEXT DEFAULT '[]',
      error TEXT,
      started_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS staff_agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      skills_tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'idle',
      assignable INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      prompt_source TEXT NOT NULL,
      creation_rationale TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_staff_agents_project ON staff_agents(project_id);
    CREATE TABLE IF NOT EXISTS auto_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      phase TEXT NOT NULL DEFAULT 'intake',
      thread_id TEXT NOT NULL,
      checkpoint_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_runs_project ON auto_runs(project_id, status);
    CREATE TABLE IF NOT EXISTS auto_run_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES auto_runs(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_run_messages ON auto_run_messages(run_id, at);
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      run_id TEXT REFERENCES auto_runs(id),
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      options_json TEXT NOT NULL DEFAULT '[]',
      recommended_option_id TEXT,
      chosen_option_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, status);
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      run_id TEXT REFERENCES auto_runs(id),
      topic TEXT NOT NULL,
      participant_ids_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT DEFAULT '',
      escalated_to_decision_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meeting_messages (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      agent_id TEXT,
      agent_name TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_policies (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      version INTEGER NOT NULL DEFAULT 1,
      policy_json TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0,
      confirmed_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

export function getDb() {
  if (!_db) {
    const sqlite = openSqlite(getDbPath());
    _db = drizzle(sqlite, { schema });
    runMigrations(_db);
  }
  return _db;
}

export { schema };
