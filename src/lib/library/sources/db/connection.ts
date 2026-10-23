import Database from "better-sqlite3";
import type { Client as PgClient } from "pg";
import { parseDbUrl, readOnlySessionSql, redactSecrets, type Dialect } from "./sql";

/**
 * One read-only connection per dialect behind a common interface. The
 * Postgres and MySQL drivers are only loaded when that dialect is
 * configured, so nothing about them runs (or needs to be installed
 * correctly) otherwise.
 *
 * Read-only on three levels: the connection itself where the driver allows
 * it (SQLite opens the file read-only; Postgres sets
 * default_transaction_read_only for the session), a read-only session
 * statement (readOnlySessionSql), and -- recommended in docs/library.md --
 * a database user that only has SELECT.
 */

export interface DbConnection {
  readonly dialect: Dialect;
  columns(sql: string): Promise<string[]>;
  all(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

class SqliteConnection implements DbConnection {
  readonly dialect = "sqlite" as const;
  private db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file, { readonly: true, fileMustExist: true });
    for (const sql of readOnlySessionSql("sqlite")) this.db.exec(sql);
  }

  async columns(sql: string): Promise<string[]> {
    return this.db.prepare(sql).columns().map((c) => c.name);
  }

  async all(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    return this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** The minimal shape of mysql2's promise connection that this file uses. */
interface MysqlConnection {
  query(sql: string): Promise<unknown>;
  execute(sql: string, params: unknown[]): Promise<[unknown, Array<{ name: string }> | undefined]>;
  end(): Promise<void>;
}

class PostgresConnection implements DbConnection {
  readonly dialect = "postgres" as const;
  constructor(private client: PgClient) {}

  async columns(sql: string): Promise<string[]> {
    return (await this.client.query(sql)).fields.map((f) => f.name);
  }
  async all(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    return (await this.client.query(sql, params)).rows;
  }
  async close(): Promise<void> {
    await this.client.end();
  }
}

class MysqlConnectionImpl implements DbConnection {
  readonly dialect = "mysql" as const;
  constructor(private conn: MysqlConnection) {}

  async columns(sql: string): Promise<string[]> {
    const [, fields] = await this.conn.execute(sql, []);
    return (fields ?? []).map((f) => f.name);
  }
  async all(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    const [rows] = await this.conn.execute(sql, params);
    return rows as Array<Record<string, unknown>>;
  }
  async close(): Promise<void> {
    await this.conn.end();
  }
}

export async function connectReadOnly(url: string): Promise<DbConnection> {
  const parsed = parseDbUrl(url);
  try {
    if (parsed.dialect === "sqlite") return new SqliteConnection(parsed.file!);
    if (parsed.dialect === "postgres") {
      const pg = (await import("pg")).default;
      const client = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on" });
      await client.connect();
      for (const sql of readOnlySessionSql("postgres")) await client.query(sql);
      return new PostgresConnection(client);
    }
    const mysql = await import("mysql2/promise");
    const conn = (await mysql.createConnection(url)) as unknown as MysqlConnection;
    for (const sql of readOnlySessionSql("mysql")) await conn.query(sql);
    return new MysqlConnectionImpl(conn);
  } catch (err) {
    // Driver errors can quote the connection string; never let it reach a log.
    throw new Error(`Couldn't connect to LIBRARY_DB_URL: ${redactSecrets(err instanceof Error ? err.message : String(err), url)}`);
  }
}
