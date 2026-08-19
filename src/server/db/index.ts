import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as schema from './schema.js';
import { getDbPath } from '../paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function runMigrations(sqlite: Database.Database) {
  const migrationsFolder = path.join(__dirname, 'migrations');
  if (fs.existsSync(migrationsFolder)) {
    migrate(drizzle(sqlite, { schema }), { migrationsFolder });
    return;
  }
  // Inline migration for first run
  sqlite.exec(`
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
}

export function getDb() {
  if (!_db) {
    const dbPath = getDbPath();
    const sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    runMigrations(sqlite);
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}

export { schema };
