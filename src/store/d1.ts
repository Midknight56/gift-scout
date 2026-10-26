import type { Cache } from '../qloo/client'
import type { Budget, ConversationState, Reservation } from '../agent/agent'
import type { ScoutEvent } from '../agent/events'
import { MAX_CALL_NEURONS } from '../limits'

interface Stmt {
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}
interface D1Like { prepare(sql: string): { bind(...v: unknown[]): Stmt } }

interface CacheRow { body: string; expires_at: number }
interface ConversationRow { state: string; turns: string }

export class D1Cache implements Cache {
  constructor(private db: D1Like, private now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT body, expires_at FROM qloo_cache WHERE key = ?').bind(key).first<CacheRow>()
    return row && row.expires_at > this.now() ? row.body : null
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const ttl = opts?.expirationTtl ?? 60 * 24 * 60 * 60
    await this.db.prepare('INSERT INTO qloo_cache (key, body, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at')
      .bind(key, value, this.now() + ttl * 1000).run()
  }
}

export class Conversations {
  constructor(private db: D1Like, private now: () => number = Date.now) {}

  async get(id: string): Promise<{ state: ConversationState; turns: ScoutEvent[][] } | null> {
    const row = await this.db.prepare('SELECT state, turns FROM conversations WHERE id = ?').bind(id).first<ConversationRow>()
    return row ? { state: JSON.parse(row.state) as ConversationState, turns: JSON.parse(row.turns) as ScoutEvent[][] } : null
  }

  async put(id: string, state: ConversationState, turns: ScoutEvent[][]): Promise<void> {
    await this.db.prepare('INSERT INTO conversations (id, state, turns, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, turns = excluded.turns, updated_at = excluded.updated_at')
      .bind(id, JSON.stringify(state), JSON.stringify(turns), this.now()).run()
  }
}

export class RunCache {
  constructor(private db: D1Like, private now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT conversation FROM run_cache WHERE key = ?').bind(key).first<{ conversation: string }>()
    return row?.conversation ?? null
  }

  async put(key: string, conversation: string): Promise<void> {
    await this.db.prepare('INSERT INTO run_cache (key, conversation, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET conversation = excluded.conversation, created_at = excluded.created_at')
      .bind(key, conversation, this.now()).run()
  }
}

export class NeuronLedger implements Budget {
  private day: () => string
  constructor(private db: D1Like, private opts: { app: string; dailyCap: number; accountCap: number; reserve?: number; day?: () => string }) {
    this.day = opts.day ?? (() => new Date().toISOString().slice(0, 10))
  }

  async spentToday(): Promise<{ app: number; all: number }> {
    const day = this.day()
    const appRow = await this.db.prepare('SELECT COALESCE(SUM(neurons), 0) AS total FROM ai_calls WHERE day = ? AND app = ?').bind(day, this.opts.app).first<{ total: number }>()
    const allRow = await this.db.prepare('SELECT COALESCE(SUM(neurons), 0) AS total FROM ai_calls WHERE day = ?').bind(day).first<{ total: number }>()
    return { app: appRow?.total ?? 0, all: allRow?.total ?? 0 }
  }

  async allow(): Promise<boolean> {
    const spent = await this.spentToday()
    const reserve = this.opts.reserve ?? MAX_CALL_NEURONS
    return spent.app + reserve <= this.opts.dailyCap && spent.all + reserve <= this.opts.accountCap
  }

  async reserve(): Promise<Reservation | null> {
    const day = this.day()
    const neurons = this.opts.reserve ?? MAX_CALL_NEURONS
    const row = await this.db.prepare('INSERT INTO ai_calls (app, day, neurons) SELECT ?, ?, ? WHERE (SELECT COALESCE(SUM(neurons),0) FROM ai_calls WHERE day = ? AND app = ?) + ? <= ? AND (SELECT COALESCE(SUM(neurons),0) FROM ai_calls WHERE day = ?) + ? <= ? RETURNING id')
      .bind(this.opts.app, day, neurons, day, this.opts.app, neurons, this.opts.dailyCap, day, neurons, this.opts.accountCap).first<{ id: number }>()
    if (!row) return null
    return {
      settle: async (spent) => {
        await this.db.prepare('UPDATE ai_calls SET neurons = ? WHERE id = ?').bind(spent, row.id).run()
      },
    }
  }
}

export function normalizeRequest(text: string): string {
  return text.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export async function runKey(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeRequest(text))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return 'run:' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
