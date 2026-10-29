/// <reference types="@cloudflare/workers-types" />
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import { clock, perVisitor, dailyNeuronShare, DAILY_QLOO_CALLS, DAILY_QLOO_CALLS_PER_VISITOR } from '../../src/limits'
import worker, { DailyCounter } from '../../src/worker'
import type { Env } from '../../src/worker'
import { newState } from '../../src/agent/agent'
import { ownerToken } from '../../src/app/buy'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const originalNow = clock.now
afterEach(() => { clock.now = originalNow })
const dbs: FakeD1[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
function db() { const d = new FakeD1(); dbs.push(d); return d }
function dailyCounter(initialDay: string, initialUsed: number) {
  const values = new Map<string, { day: string; used: number }>([['c', { day: initialDay, used: initialUsed }]])
  const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: { day: string; used: number }) => { values.set(key, value) } }
  const counter = new DailyCounter({} as never, {} as never)
  ;(counter as unknown as { ctx: { storage: typeof storage } }).ctx = { storage }
  return counter
}

describe('judging visitor caps', () => {
  it('raises only visitor caps during the judging window', () => {
    const t = (s: string) => Date.parse(s)
    for (const [at, expected] of [
      ['2026-11-01T23:59:59.999Z', 12], ['2026-11-02T00:00:00Z', 48],
      ['2026-11-05T23:59:00Z', 48], ['2026-11-06T12:00:00Z', 12], ['2026-11-07T00:00:00Z', 12],
    ] as const) expect(perVisitor(12, t(at))).toBe(expected)
    expect(perVisitor(3, t('2026-11-03T12:00:00Z'))).toBe(12)
    expect(perVisitor(3, t('2026-11-07T00:00:00Z'))).toBe(3)
  })

  it('uses the shared clock for default neuron shares', () => {
    clock.now = () => Date.parse('2026-11-03T12:00:00Z')
    expect(dailyNeuronShare()).toBe(3500)
    clock.now = () => Date.parse('2026-11-07T00:00:00Z')
    expect(dailyNeuronShare()).toBe(2000)
  })

  it('keeps the whole app Qloo cap while allowing the raised visitor cap', async () => {
    expect(await dailyCounter('2026-11-02', 2000).take('2026-11-02', DAILY_QLOO_CALLS)).toBe(false)
    expect(await dailyCounter('2026-11-02', 200).take('2026-11-02', perVisitor(DAILY_QLOO_CALLS_PER_VISITOR, Date.parse('2026-11-02T12:00:00Z')))).toBe(true)
  })
})

describe('worker judging limits', () => {
  it('passes the time-specific turns limit to the visitor counter', async () => {
    const dbs: FakeD1[] = []
    const originalFetch = globalThis.fetch
    try {
      const db = new FakeD1(); dbs.push(db)
      const calls: Array<[string, number]> = []
      const env = {
        DB: db, LEDGER: db, SESSION_SECRET: 'test', ASSETS: { fetch: async () => new Response('') },
        COUNTERS: { idFromName: (name: string) => name, get: (name: string) => ({ take: async (_day: string, limit: number) => { calls.push([String(name), limit]); return true } }) },
        AI: { run: async () => ({ response: 'Please tell me more.', usage: { prompt_tokens: 1, completion_tokens: 1 } }) }, QLOO_API_KEY: 'fake',
      } as unknown as Env
      const pending: Promise<unknown>[] = []
      const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext
      globalThis.fetch = (async () => Response.json({ results: [] })) as typeof fetch
      for (const [at, limit] of [
        ['2026-11-01T12:00:00Z', 12], ['2026-11-02T12:00:00Z', 48],
        ['2026-11-05T20:00:00Z', 48], ['2026-11-07T12:00:00Z', 12],
      ] as const) {
        calls.length = 0
        clock.now = () => Date.parse(at)
        const response = await worker.fetch(new Request('https://gift.test/api/scout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ message: 'My aunt loves music and books.' }) }), env, ctx)
        await response.text(); await Promise.all(pending.splice(0))
        expect(calls.find(([name]) => name.startsWith('turns:'))?.[1]).toBe(limit)
      }
    } finally { globalThis.fetch = originalFetch; for (const db of dbs) db.close() }
  })

  it('does not request Qloo when the whole app counter refuses', async () => {
    const urls: string[] = [], originalFetch = globalThis.fetch
    const h = new FakeD1(); dbs.push(h)
    clock.now = () => Date.parse('2026-11-02T12:00:00Z')
    const names: string[] = []
    const env = {
      DB: h, LEDGER: h, SESSION_SECRET: 'test', ASSETS: { fetch: async () => new Response('') },
      COUNTERS: { idFromName: (name: string) => name, get: (name: string) => ({ take: async () => { names.push(name); return name !== 'qloo-total' } }) },
      AI: { run: async () => ({
        choices: [{ message: { content: '', tool_calls: [{ id: 'plan', type: 'function', function: {
          name: 'plan_scout', arguments: JSON.stringify({ loves: [{ name: 'Phoebe Bridgers', kind: 'named' }] }),
        } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
      }) }, QLOO_API_KEY: 'fake',
    } as unknown as Env
    const pending: Promise<unknown>[] = [], ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => { urls.push(String(input)); return Response.json({ results: [] }) }) as typeof fetch
      const response = await worker.fetch(new Request('https://gift.test/api/scout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ message: 'My aunt loves Phoebe Bridgers.' }) }), env, ctx)
      await response.text(); await Promise.all(pending)
      expect(names).toContain('qloo-total')
      expect(urls.filter((url) => new URL(url).host.includes('qloo'))).toEqual([])
    } finally { globalThis.fetch = originalFetch }
  })

  it('uses judging compare limits through the worker for an owned conversation', async () => {
    const d = db(), limits: number[] = [], originalFetch = globalThis.fetch
    const id = 'judgecompare'
    const state = { ...newState(id), turn: 1, said: ['My aunt loves music and books.'], calls: 1, cards: [{ id: 't1c1', gift: 'A record', why: 'She likes music.', price_low: 10, price_high: 20, entity: { id: 'CARD1', name: 'Card one', type: 'brand' }, seeds: ['Folk artist'], from_call: 1 }] }
    const cards = { t: 'cards' as const, cards: state.cards, dropped: [] }
    await new Conversations(d).put(id, state, [[cards]])
    const env = {
      DB: d, LEDGER: d, SESSION_SECRET: 'test', ASSETS: { fetch: async () => new Response('') },
      COUNTERS: { idFromName: (name: string) => name, get: (name: string) => ({ take: async (_day: string, limit: number) => { if (name.startsWith('compares:')) limits.push(limit); return true } }) },
      AI: { run: async () => ({ response: '[]', usage: { prompt_tokens: 1, completion_tokens: 1 } }) }, QLOO_API_KEY: 'fake',
    } as unknown as Env
    const pending: Promise<unknown>[] = [], ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext
    try {
      globalThis.fetch = (async () => Response.json({ results: { entities: [] } })) as typeof fetch
      for (const [at, expected] of [['2026-11-03T12:00:00Z', 12], ['2026-11-07T12:00:00Z', 3]] as const) {
        clock.now = () => Date.parse(at); limits.length = 0
        const response = await worker.fetch(new Request('https://gift.test/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: id, owner: await ownerToken(id, 'test') }) }), env, ctx)
        await response.text(); await Promise.all(pending.splice(0))
        expect(limits).toContain(expected)
      }
    } finally { globalThis.fetch = originalFetch }
  })
})


