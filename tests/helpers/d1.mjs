import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Real SQLite executes D1's public schema, CHECKs, RETURNING and transactional
// triggers. This adapter translates binding methods without imitating app logic.
export class SQLiteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../../cloudflare/d1-schema.sql', import.meta.url), 'utf8'));
  }
  withSession(consistency) { assert.equal(consistency, 'first-primary'); return this; }
  prepare(sql) {
    const sqlite = this.sqlite;
    const statement = (values = []) => ({
      bind: (...next) => statement(next),
      first: async () => sqlite.prepare(sql).get(...values) || null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => ({ success: true, meta: sqlite.prepare(sql).run(...values) }),
      _execute: () => sqlite.prepare(sql).run(...values),
    });
    return statement();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement._execute()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close() { this.sqlite.close(); }
}
