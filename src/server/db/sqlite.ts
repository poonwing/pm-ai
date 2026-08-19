import { DatabaseSync, type SQLInputValue, type StatementResultingChanges, type StatementSync } from 'node:sqlite';
import { sql } from 'drizzle-orm';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import * as drizzleUtils from 'drizzle-orm/utils';
import { fillPlaceholders } from 'drizzle-orm/sql/sql';
import { DefaultLogger, NoopLogger, type Logger } from 'drizzle-orm/logger';
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations';
import { readMigrationFiles, type MigrationConfig } from 'drizzle-orm/migrator';
import {
  BaseSQLiteDatabase,
  SQLitePreparedQuery,
  SQLiteSession,
  SQLiteSyncDialect,
  SQLiteTransaction,
  type SQLiteTransactionConfig,
} from 'drizzle-orm/sqlite-core';
import type { SelectedFieldsOrdered } from 'drizzle-orm/sqlite-core/query-builders/select.types';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';
import type { Query } from 'drizzle-orm/sql/sql';

function assertSupportedNode(): void {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) return;
  throw new Error(
    `pm-ai 需要 Node.js >= 22.13（目前 ${process.versions.node}）。内置 sqlite 从 22.13 起不再需要 --experimental-sqlite。`,
  );
}

function toSqlParams(params: unknown[]): SQLInputValue[] {
  return params.map((value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined) return null;
    return value as SQLInputValue;
  });
}

function rowValues(row: unknown): unknown[] {
  if (row == null) return [];
  if (Array.isArray(row)) return row;
  return Object.values(row as Record<string, unknown>);
}

const mapResultRow = (
  drizzleUtils as unknown as {
    mapResultRow: (
      columns: SelectedFieldsOrdered,
      row: unknown[],
      joinsNotNullableMap?: Record<string, boolean>,
    ) => unknown;
  }
).mapResultRow;

type RunResult = StatementResultingChanges;

class NodeSqlitePreparedQuery extends SQLitePreparedQuery<{
  type: 'sync';
  run: RunResult;
  all: unknown[];
  get: unknown;
  values: unknown[][];
  execute: unknown;
}> {
  constructor(
    private readonly stmt: StatementSync,
    query: Query,
    private readonly logger: Logger,
    private readonly fields: SelectedFieldsOrdered | undefined,
    executeMethod: 'run' | 'all' | 'get',
    private readonly _isResponseInArrayMode: boolean,
    private readonly customResultMapper?: (rows: unknown[][]) => unknown,
  ) {
    super('sync', executeMethod, query);
  }

  run(placeholderValues?: Record<string, unknown>) {
    const params = toSqlParams(fillPlaceholders(this.query.params, placeholderValues ?? {}));
    this.logger.logQuery(this.query.sql, params);
    return this.stmt.run(...params);
  }

  all(placeholderValues?: Record<string, unknown>) {
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      const params = toSqlParams(fillPlaceholders(this.query.params, placeholderValues ?? {}));
      this.logger.logQuery(this.query.sql, params);
      return this.stmt.all(...params);
    }
    const rows = this.values(placeholderValues);
    if (customResultMapper) return customResultMapper(rows) as unknown[];
    return rows.map((row) => mapResultRow(fields!, row, this.joinsNotNullable));
  }

  get(placeholderValues?: Record<string, unknown>) {
    const params = toSqlParams(fillPlaceholders(this.query.params, placeholderValues ?? {}));
    this.logger.logQuery(this.query.sql, params);
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      return this.stmt.get(...params);
    }
    const row = this.stmt.get(...params);
    if (row == null) return undefined;
    const values = rowValues(row);
    if (customResultMapper) return customResultMapper([values]);
    return mapResultRow(fields!, values, this.joinsNotNullable);
  }

  private get joinsNotNullable() {
    return (this as unknown as { joinsNotNullableMap?: Record<string, boolean> }).joinsNotNullableMap;
  }

  values(placeholderValues?: Record<string, unknown>) {
    const params = toSqlParams(fillPlaceholders(this.query.params, placeholderValues ?? {}));
    this.logger.logQuery(this.query.sql, params);
    return this.stmt.all(...params).map(rowValues);
  }

  isResponseInArrayMode() {
    return this._isResponseInArrayMode;
  }
}

class NodeSqliteSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteSession<'sync', RunResult, TFullSchema, TSchema> {
  private readonly logger: Logger;

  constructor(
    private readonly client: DatabaseSync,
    private readonly sqliteDialect: SQLiteSyncDialect,
    private readonly schema: RelationalSchemaConfig<TSchema> | undefined,
    options: { logger?: Logger } = {},
  ) {
    super(sqliteDialect);
    this.logger = options.logger ?? new NoopLogger();
  }

  dialectForNested() {
    return this.sqliteDialect;
  }

  prepareQuery(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: 'run' | 'all' | 'get',
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => unknown,
  ) {
    return new NodeSqlitePreparedQuery(
      this.client.prepare(query.sql),
      query,
      this.logger,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper,
    );
  }

  transaction<T>(
    transaction: (tx: SQLiteTransaction<'sync', RunResult, TFullSchema, TSchema>) => T,
    config: SQLiteTransactionConfig = {},
  ): T {
    const tx = new NodeSqliteTransaction('sync', this.sqliteDialect, this, this.schema);
    this.run(sql.raw(`begin ${config.behavior ?? 'deferred'}`));
    try {
      const result = transaction(tx);
      this.run(sql`commit`);
      return result;
    } catch (err) {
      this.run(sql`rollback`);
      throw err;
    }
  }
}

class NodeSqliteTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends SQLiteTransaction<'sync', RunResult, TFullSchema, TSchema> {
  constructor(
    resultType: 'sync',
    dialect: SQLiteSyncDialect,
    private readonly sqliteSession: NodeSqliteSession<TFullSchema, TSchema>,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex?: number,
  ) {
    super(resultType, dialect, sqliteSession, schema, nestedIndex);
  }

  transaction<T>(transaction: (tx: this) => T): T {
    const savepointName = `sp${this.nestedIndex}`;
    const tx = new NodeSqliteTransaction(
      'sync',
      this.sqliteSession.dialectForNested(),
      this.sqliteSession,
      this.schema,
      this.nestedIndex + 1,
    );
    this.sqliteSession.run(sql.raw(`savepoint ${savepointName}`));
    try {
      const result = transaction(tx as this);
      this.sqliteSession.run(sql.raw(`release savepoint ${savepointName}`));
      return result;
    } catch (err) {
      this.sqliteSession.run(sql.raw(`rollback to savepoint ${savepointName}`));
      throw err;
    }
  }
}

export type NodeSqliteDatabase<TSchema extends Record<string, unknown> = Record<string, never>> =
  BaseSQLiteDatabase<'sync', RunResult, TSchema> & { $client: DatabaseSync };

export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  client: DatabaseSync,
  config: DrizzleConfig<TSchema> = {},
): NodeSqliteDatabase<TSchema> {
  const dialect = new SQLiteSyncDialect({ casing: config.casing });
  let logger: Logger | undefined;
  if (config.logger === true) logger = new DefaultLogger();
  else if (config.logger !== false) logger = config.logger;

  let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  const session = new NodeSqliteSession(client, dialect, schema, { logger });
  const db = new BaseSQLiteDatabase('sync', dialect, session, schema) as NodeSqliteDatabase<TSchema>;
  db.$client = client;
  return db;
}

export function migrate<TSchema extends Record<string, unknown>>(
  db: NodeSqliteDatabase<TSchema>,
  config: MigrationConfig,
) {
  const migrations = readMigrationFiles(config);
  const internal = db as unknown as {
    dialect: SQLiteSyncDialect;
    session: NodeSqliteSession<Record<string, unknown>, TablesRelationalConfig>;
  };
  internal.dialect.migrate(migrations, internal.session, config);
}

export function openSqlite(filePath: string): DatabaseSync {
  assertSupportedNode();
  const sqlite = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
  sqlite.exec('PRAGMA journal_mode = WAL');
  return sqlite;
}
