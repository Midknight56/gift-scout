/// <reference types="@cloudflare/workers-types" />
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import { runTurn, newState, type Budget } from '../../src/agent/agent'
import type { Model, ModelReply, ToolCall } from '../../src/agent/model'
import { EXAMPLES, scoutTurn, type RecordedRun, type ScoutDeps } from '../../src/app/scout'
import { buyTurn, ownerToken } from '../../src/app/buy'
import { qlooTools } from '../../src/qloo/tools'
import { QlooClient, type Cache } from '../../src/qloo/client'
import { DAILY_BUYS_PER_VISITOR, DAILY_TURNS_PER_VISITOR, DAILY_QLOO_CALLS, DAILY_QLOO_CALLS_PER_VISITOR, DEFAULT_DAILY_NEURONS, DEFAULT_ACCOUNT_NEURONS, MAX_CALL_NEURONS } from '../../src/limits'
import { NeuronLedger, Conversations, RunCache } from '../../src/store/d1'
import { DailyCounter } from '../../src/worker'
import type { ScoutEvent } from '../../src/agent/events'
import { FakeD1 } from './fake-d1'

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

let callId = 0
function call(name: string, args: unknown): ToolCall {
  return { id: `battle-${++callId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
function reply(calls: ToolCall[] = [], extra: Partial<ModelReply> = {}): ModelReply {
  return { content: '', tool_calls: calls, prompt_tokens: 1000, completion_tokens: 100, ...extra }
}
function scripted(replies: ModelReply[]): Model & { calls: number } {
  const model = {
    name: 'battle-script', calls: 0,
    async chat() { model.calls++; const next = replies.shift(); if (!next) throw new Error('unexpected model call'); return next },
  }
  return model
}
const open: Budget = { allow: async () => true, reserve: async () => ({ settle: async () => {} }) }
const answerQloo = async (input: RequestInfo | URL) => {
  const url = new URL(String(input))
  const body = url.pathname === '/search'
    ? { results: [{ entity_id: 'PB', name: 'Phoebe Bridgers', types: ['urn:entity:artist'] }] }
    : { results: { entities: [{ entity_id: 'B-1', name: 'Fender', subtype: 'urn:entity:brand' }] } }
  return new Response(JSON.stringify(body))
}
function qloo(allow: () => Promise<boolean>, fetcher: typeof fetch = answerQloo as typeof fetch) {
  const cache: Cache = { get: async () => null, put: async () => {} }
  return { qloo: new QlooClient('key', fetcher, cache, allow) }
}
const planReply = () => reply([call('plan_scout', { loves: [{ name: 'Phoebe Bridgers', kind: 'named' }] })])
const giftsReply = () => reply([call('present_gifts', { cards: [{ entity_id: 'B-1', gift: 'A Fender strap', why: 'A good gift for her.', price_low: 20, price_high: 40 }] })])

function scoutDeps(model: Model, budget: Budget, ctx = qloo(async () => true), visitor = async () => true, recorded: RecordedRun[] = []): ScoutDeps {
  const d = db(); let ids = 0
  return {
    conversations: new Conversations(d), runs: new RunCache(d), recorded: async () => recorded, tools: qlooTools(),
    live: { model, ctx, budget, takeVisitorTurn: visitor },
    newId: () => `battle${String(++ids).padStart(4, '0')}`,
    ownerToken: (id) => ownerToken(id, 'battle-secret'), paceMs: 0,
  }
}
async function streamTurn(deps: ScoutDeps, message: string, conversation?: string) {
  const events: ScoutEvent[] = []
  await scoutTurn(message, conversation, deps, async (event) => { events.push(event) })
  return events
}

describe('cap battle tests', () => {
  it('stops an app neuron cap crossed after the first model call', async () => {
    const ledgerDb = db()
    const ledger = new NeuronLedger(ledgerDb, { app: 'gift-scout', dailyCap: 100, accountCap: 1000, reserve: 50, day: () => 'battle-day' })
    const model = scripted([reply([], { content: 'Thinking.', neurons: 51 }), giftsReply()])
    const events = await streamTurn(scoutDeps(model, ledger), 'My sister loves Phoebe Bridgers.')
    expect(model.calls).toBe(1)
    expect(events.some((e) => e.t === 'error' && /budget for today/.test(e.text))).toBe(true)
    expect(events.at(-1)?.t).toBe('done')
    expect(events.some((e) => e.t === 'cards')).toBe(false)
  })

  it('stops a shared account neuron cap crossed after the first model call', async () => {
    const ledgerDb = db()
    const ledger = new NeuronLedger(ledgerDb, { app: 'gift-scout', dailyCap: 1000, accountCap: 100, reserve: 50, day: () => 'battle-day' })
    const model = scripted([reply([], { content: 'Thinking.', neurons: 51 }), giftsReply()])
    ledgerDb.insertCall('another-app', 'battle-day', 0)
    const events = await streamTurn(scoutDeps(model, ledger), 'My sister loves Phoebe Bridgers.')
    expect(model.calls).toBe(1)
    expect(events.some((e) => e.t === 'error' && /budget for today/.test(e.text))).toBe(true)
    expect(events.at(-1)?.t).toBe('done')
    expect(events.some((e) => e.t === 'cards')).toBe(false)
  })

  it('allows exactly one reserved call at the cap minus the reserve and none one neuron later', async () => {
    for (const [spent, expected] of [[200 - MAX_CALL_NEURONS, true], [201 - MAX_CALL_NEURONS, false]] as const) {
      const ledgerDb = db()
      ledgerDb.insertCall('gift-scout', 'battle-day', spent)
      const ledger = new NeuronLedger(ledgerDb, { app: 'gift-scout', dailyCap: 200, accountCap: 200, reserve: MAX_CALL_NEURONS, day: () => 'battle-day' })
      expect(await ledger.allow()).toBe(expected)
    }
  })

  it.each(['daily Qloo cap', 'per visitor Qloo cap'])('refuses the next Qloo call at the %s mid turn without crashing or fabricating cards', async (cap) => {
    const daily = dailyCounter('battle-day', cap === 'daily Qloo cap' ? DAILY_QLOO_CALLS - 1 : 0)
    const visitor = dailyCounter('battle-day', cap === 'per visitor Qloo cap' ? DAILY_QLOO_CALLS_PER_VISITOR - 1 : 0)
    let fetches = 0
    const allow = async () => await visitor.take('battle-day', DAILY_QLOO_CALLS_PER_VISITOR) && await daily.take('battle-day', DAILY_QLOO_CALLS)
    const ctx = qloo(allow, (async (input: RequestInfo | URL) => { fetches++; return answerQloo(input) }) as typeof fetch)
    const model = scripted([planReply(), giftsReply()])
    const events = await streamTurn(scoutDeps(model, open, ctx), 'My sister loves Phoebe Bridgers.')
    expect(fetches).toBe(1)
    expect(model.calls).toBe(1)
    expect(events.some((e) => e.t === 'error' && /Qloo is not answering/.test(e.text))).toBe(true)
    expect(events.at(-1)?.t).toBe('done')
    expect(events.some((e) => e.t === 'cards')).toBe(false)
  })

  it('denies the thirteenth live visitor turn while still replaying an example', async () => {
    let used = DAILY_TURNS_PER_VISITOR
    const take = async () => { if (used >= DAILY_TURNS_PER_VISITOR) return false; used++; return true }
    const model = scripted([giftsReply()])
    const recorded: RecordedRun = {
      recorded_at: '2026-10-23',
      turns: [[{ t: 'run', conversation: 'old0001', turn: 1, mode: 'live' }, { t: 'cards', cards: [], dropped: [] }]],
      states: [{ ...newState('old0001'), turn: 1, said: [EXAMPLES[0]] }],
    }
    const deps = scoutDeps(model, open, qloo(async () => true), take, [recorded])
    const denied = await streamTurn(deps, 'A brand new live request for turn thirteen.')
    expect(model.calls).toBe(0)
    expect(denied.find((e) => e.t === 'error')?.text).toMatch(/scouted a lot today/)
    const replay = await streamTurn(deps, EXAMPLES[0])
    expect(replay[0]).toMatchObject({ t: 'run', mode: 'replay' })
    expect(replay.at(-1)?.t).toBe('done')
  })

  it('denies the seventh daily buy before a model call or PayPal order', async () => {
    let used = DAILY_BUYS_PER_VISITOR
    const take = async () => { if (used >= DAILY_BUYS_PER_VISITOR) return false; used++; return true }
    const store = db(), conversations = new Conversations(store)
    const id = 'buybattle1'
    await conversations.put(id, { ...newState(id), turn: 1, cards: [{ id: 't1c1', gift: 'Gift', why: 'A good fit.', price_low: 10, price_high: 20, entity: { id: 'B-1', name: 'Fender', type: 'brand' }, seeds: [], from_call: 1 }] }, [])
    let orders = 0
    const paypal = { createOrder: async () => { orders++; throw new Error('must not create') } } as never
    const model = scripted([reply([call('buy_gift', { card_id: 't1c1', amount_usd: 15 })])])
    const events: ScoutEvent[] = []
    await buyTurn(id, 't1c1', { conversations, paypal, live: { model, budget: open, takeVisitorBuy: take }, origin: 'https://gift.test', ownerSecret: 'battle-secret' }, async (e) => { events.push(e) }, 'paypal', await ownerToken(id, 'battle-secret'))
    expect(model.calls).toBe(0)
    expect(orders).toBe(0)
    expect(events.some((e) => e.t === 'error' && /bought a lot today/.test(e.text))).toBe(true)
    expect(events.at(-1)?.t).toBe('error')
    expect(events.at(-1)).toMatchObject({ text: expect.stringMatching(/bought a lot today/) })
  })

  it('resets a DailyCounter on a new day', async () => {
    const values = new Map<string, { day: string; used: number }>()
    const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: { day: string; used: number }) => { values.set(key, value) } }
    const counter = new DailyCounter({} as never, {} as never)
    ;(counter as unknown as { ctx: { storage: typeof storage } }).ctx = { storage }
    expect(await counter.take('day-1', 1)).toBe(true)
    expect(await counter.take('day-1', 1)).toBe(false)
    expect(await counter.take('day-2', 1)).toBe(true)
  })

  it('keeps visitor counters separate', async () => {
    const stores = new Map<string, Map<string, { day: string; used: number }>>()
    const visitorCounter = async (visitor: string, day: string, cap: number) => {
      const values = stores.get(visitor) ?? new Map<string, { day: string; used: number }>()
      stores.set(visitor, values)
      const counter = new DailyCounter({} as never, {} as never)
      const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: { day: string; used: number }) => { values.set(key, value) } }
      ;(counter as unknown as { ctx: { storage: typeof storage } }).ctx = { storage }
      return counter.take(day, cap)
    }
    for (let i = 0; i < DAILY_TURNS_PER_VISITOR; i++) expect(await visitorCounter('A', 'day', DAILY_TURNS_PER_VISITOR)).toBe(true)
    expect(await visitorCounter('A', 'day', DAILY_TURNS_PER_VISITOR)).toBe(false)
    expect(await visitorCounter('B', 'day', DAILY_TURNS_PER_VISITOR)).toBe(true)
  })

  it('bounds concurrent neuron overshoot to five maximum sized calls', async () => {
    const ledgerDb = db()
    const cap = DEFAULT_DAILY_NEURONS
    ledgerDb.insertCall('gift-scout', 'battle-day', cap - 60)
    const ledger = new NeuronLedger(ledgerDb, { app: 'gift-scout', dailyCap: cap, accountCap: DEFAULT_ACCOUNT_NEURONS, reserve: MAX_CALL_NEURONS, day: () => 'battle-day' })
    const models = Array.from({ length: 5 }, () => scripted([reply([], { neurons: MAX_CALL_NEURONS })]))
    await Promise.all(models.map((model, i) => runTurn({
      message: `Concurrent test ${i} loves Phoebe Bridgers.`, state: newState(`parallel${i}`), model, tools: [],
      ctx: qloo(async () => true), budget: ledger, emit: () => {},
    })))
    const { app } = await ledger.spentToday()
    const overshoot = Math.max(0, app - cap)
    console.info(`Concurrent neuron boundary overshoot: ${overshoot} neurons`)
    expect(overshoot).toBeLessThanOrEqual(5 * MAX_CALL_NEURONS)
    expect(models.reduce((total, model) => total + model.calls, 0)).toBeLessThanOrEqual(5)
  })
})
