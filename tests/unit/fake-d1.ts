import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

class FakeStatement {
  private values: SQLInputValue[] = []
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...v: unknown[]): this { this.values = v as SQLInputValue[]; return this }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] }
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.db.prepare(this.sql).run(...this.values)
    return { meta: { changes: Number(result.changes) } }
  }
}

export class FakeD1 {
  private database = new DatabaseSync(':memory:')
  constructor() {
    const migration = readFileSync(resolve(process.cwd(), 'migrations/0001_init.sql'), 'utf8')
    this.database.exec(migration)
    this.database.exec(readFileSync(resolve(process.cwd(), 'migrations/0002_replay.sql'), 'utf8'))
    this.database.exec(readFileSync(resolve(process.cwd(), 'migrations/0003_qloo_quota.sql'), 'utf8'))
  }
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.database, sql)
  }
  close(): void { this.database.close() }
  /** Test helper for inserting shared-account ledger entries. */
  insertCall(app: string, day: string, neurons: number, at = Date.now()): void {
    this.database.prepare('INSERT INTO ai_calls (app, day, neurons, at) VALUES (?, ?, ?, ?)').run(app, day, neurons, at)
  }
}
