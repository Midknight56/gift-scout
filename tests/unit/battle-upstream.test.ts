/// <reference types="@cloudflare/workers-types" />
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import { QlooClient, QlooError, type Cache } from '../../src/qloo/client'
import { Channel3Client } from '../../src/channel3/client'
import { PayPal, PayPalError } from '../../src/paypal/client'
import { buyTurn, ownerToken, paidReturn } from '../../src/app/buy'
import { scoutTurn, type ScoutDeps } from '../../src/app/scout'
import { newState, type Budget } from '../../src/agent/agent'
import { WorkersAiModel, type ModelReply } from '../../src/agent/model'
import type { ScoutEvent } from '../../src/agent/events'
import { qlooTools } from '../../src/qloo/tools'
import worker, { type Env } from '../../src/worker'
import { Conversations, RunCache } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const SECRET = 'battle-secret-that-must-not-leak'
class MemoryCache implements Cache {
  values = new Map<string, string>()
  async get(k: string) { return this.values.get(k) ?? null }
  async put(k: string, v: string) { this.values.set(k, v) }
}
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers })
const failFetch = (message = SECRET) => (async () => { throw new Error(message) }) as typeof fetch
const qAnswer = { results: [{ entity_id: 'E-1', name: 'Phoebe Bridgers', types: ['urn:entity:artist'] }] }

function qClient(fetcher: typeof fetch, cache = new MemoryCache()) {
  return { client: new QlooClient(SECRET, fetcher, cache, async () => true), cache }
}
function paypal(fetcher: typeof fetch) { return new PayPal('id', SECRET, fetcher, 'https://paypal.test') }
const tokenResponse = () => json({ access_token: 'token-private', expires_in: 3600 })
const orderResponse = () => json({ id: 'ORDER123', status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal.test/approve' }] })

describe('Qloo attacks', () => {
  const invoke = (c: QlooClient) => c.search('Phoebe Bridgers', 'artist')
  it.each([
    ['500', () => json({ errors: [{ message: SECRET }] }, 500)],
    ['429 without Retry-After', () => json({}, 429)],
    ['429 with Retry-After', () => json({}, 429, { 'Retry-After': '3' })],
    ['timeout', () => { throw new DOMException(SECRET, 'AbortError') }],
    ['non-JSON', () => new Response('not json')],
    ['empty JSON', () => json({})],
    ['wrong-shaped JSON', () => json({ results: null })],
  ])('does not cache or expose a %s as an answer', async (_label, answer) => {
    const cache = new MemoryCache()
    const fetcher = (async () => answer()) as typeof fetch
    const { client } = qClient(fetcher, cache)
    await expect(invoke(client)).rejects.toBeInstanceOf(QlooError)
    expect(cache.values.size).toBe(0)
    try { await invoke(client) } catch (e) { expect(String(e)).not.toContain(SECRET) }
  })
  it('does not cache a network failure', async () => {
    const cache = new MemoryCache(), { client } = qClient(failFetch(), cache)
    await expect(invoke(client)).rejects.toBeInstanceOf(QlooError)
    expect(cache.values.size).toBe(0)
  })
  it('does not cache a 500: a later identical request gets the real answer', async () => {
    const cache = new MemoryCache(); let n = 0
    const fetcher = (async () => ++n === 1 ? json({}, 500) : json(qAnswer)) as typeof fetch
    const { client } = qClient(fetcher, cache)
    await expect(invoke(client)).rejects.toBeInstanceOf(QlooError)
    await expect(invoke(client)).resolves.toMatchObject({ cached: false, results: [{ name: 'Phoebe Bridgers' }] })
    expect(n).toBe(2); expect(cache.values.size).toBe(1)
  })
})

describe('Channel3 attacks', () => {
  it.each([
    ['500', async () => json({}, 500)], ['429 without Retry-After', async () => json({}, 429)],
    ['429 with Retry-After', async () => json({}, 429, { 'Retry-After': '1' })],
    ['timeout', async () => { throw new DOMException(SECRET, 'AbortError') }],
    ['non-JSON', async () => new Response('nope')], ['empty JSON', async () => json({})],
    ['wrong-shaped JSON', async () => json({ products: null })], ['network error', async () => { throw new Error(SECRET) }],
  ])('returns a safe error for %s and does not cache it', async (_label, response) => {
    const cache = new MemoryCache(); const result = await new Channel3Client(SECRET, (async () => response()) as typeof fetch, cache, async () => true, async () => {}).search('gift')
    expect(result).toEqual({ ok: false, reason: 'error' }); expect(cache.values.size).toBe(0); expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})

describe('PayPal attacks', () => {
  const tokenFailures = [
    ['500', async () => json({}, 500)], ['429 without Retry-After', async () => json({}, 429)],
    ['429 with Retry-After', async () => json({}, 429, { 'Retry-After': '2' })],
    ['timeout', async () => { throw new DOMException(SECRET, 'AbortError') }],
    ['non-JSON', async () => new Response('nope')], ['empty JSON', async () => json({})],
    ['wrong-shaped JSON', async () => json({ access_token: 7, expires_in: 'forever' })],
    ['network error', async () => { throw new Error(SECRET) }],
  ] as const
  it.each(tokenFailures)('token %s fails safely before any order is created', async (_label, token) => {
    let orders = 0
    const p = paypal((async (url: RequestInfo | URL) => String(url).endsWith('/token') ? token() : (orders++, orderResponse())) as typeof fetch)
    await expect(p.createOrder({ amount: '20.00', customId: 'gs-conv1234-t1c1', description: 'Gift', returnUrl: 'r', cancelUrl: 'c', requestId: 'once' })).rejects.toBeInstanceOf(PayPalError)
    expect(orders).toBe(0)
  })
  const ops = [
    ['create order 500', 'create', async () => json({}, 500)], ['create order 429', 'create', async () => json({}, 429)],
    ['create order timeout', 'create', async () => { throw new DOMException(SECRET, 'AbortError') }], ['create order non-JSON', 'create', async () => new Response('nope')],
    ['create order empty JSON', 'create', async () => json({})], ['create order wrong shape', 'create', async () => json({ status: 'CREATED' })],
    ['create order network error', 'create', async () => { throw new Error(SECRET) }],
    ['capture 500', 'capture', async () => json({}, 500)], ['capture 429', 'capture', async () => json({}, 429)],
    ['capture timeout', 'capture', async () => { throw new DOMException(SECRET, 'AbortError') }], ['capture non-JSON', 'capture', async () => new Response('nope')],
    ['capture empty JSON', 'capture', async () => json({})], ['capture wrong shape', 'capture', async () => json({ purchase_units: [] })],
    ['capture network error', 'capture', async () => { throw new Error(SECRET) }],
  ] as const
  it.each(ops)('%s fails without exposing secrets', async (_label, operation, answer) => {
    let created = false
    const fetcher = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/token')) return tokenResponse()
      if (String(url).endsWith('/capture')) return answer()
      if (operation === 'create') return answer()
      created = true; return orderResponse()
    }) as typeof fetch
    const p = paypal(fetcher)
    const call = operation === 'create'
      ? p.createOrder({ amount: '20.00', customId: 'gs-conv1234-t1c1', description: 'Gift', returnUrl: 'r', cancelUrl: 'c', requestId: 'once' })
      : p.capture('ORDER123')
    await expect(call).rejects.toBeInstanceOf(PayPalError)
    expect(JSON.stringify({ created })).not.toContain(SECRET)
  })
})

const dbs: FakeD1[] = []
afterEach(() => { vi.useRealTimers(); for (const db of dbs.splice(0)) db.close() })
function makeDb() { const d = new FakeD1(); dbs.push(d); return { db: d, conversations: new Conversations(d) } }
const budget: Budget = { allow: async () => true, reserve: async () => ({ settle: async () => {} }) }
const cardState = () => ({ ...newState('conv1234'), turn: 1, cards: [{ id: 't1c1', gift: 'Gift', why: 'A fitting gift.', price_low: 10, price_high: 30, entity: { id: 'E1', name: 'Gift', type: 'brand' }, seeds: [], from_call: 1 }] })
const buyModel = { name: 'buy', async chat(): Promise<ModelReply> { return { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'buy_gift', arguments: JSON.stringify({ card_id: 't1c1', amount_usd: 20 }) } }], prompt_tokens: 10, completion_tokens: 2 } } }

describe('buy stream and charge safety', () => {
  it('token failure creates no order, sends a plain error, and closes with done', async () => {
    const { conversations } = makeDb(); await conversations.put('conv1234', cardState(), [])
    let orderCalls = 0
    const p = paypal((async (url: RequestInfo | URL) => String(url).endsWith('/token') ? json({}, 500) : (orderCalls++, orderResponse())) as typeof fetch)
    const events: ScoutEvent[] = []
    await buyTurn('conv1234', 't1c1', { conversations, paypal: p, live: { model: buyModel, budget, takeVisitorBuy: async () => true }, origin: 'https://gift.test', ownerSecret: 'owner' }, async (e) => { events.push(e) }, 'paypal', await ownerToken('conv1234', 'owner'))
    expect(orderCalls).toBe(0); expect(events.at(-1)?.t).toBe('done'); expect(events.find((e) => e.t === 'error')).toBeTruthy()
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })
  it('does not call a possibly captured card payment “nothing charged” or mark it paid after create returns 500', async () => {
    const { conversations } = makeDb(); await conversations.put('conv1234', cardState(), [])
    const p = paypal((async (url: RequestInfo | URL) => String(url).endsWith('/token') ? tokenResponse() : json({ debug_id: SECRET }, 500)) as typeof fetch)
    const events: ScoutEvent[] = []
    await buyTurn('conv1234', 't1c1', { conversations, paypal: p, live: { model: buyModel, budget, takeVisitorBuy: async () => true }, origin: 'https://gift.test', ownerSecret: 'owner' }, async (e) => { events.push(e) }, 'card', await ownerToken('conv1234', 'owner'))
    const saved = await conversations.get('conv1234')
    expect(events.at(-1)?.t).toBe('done'); expect(JSON.stringify(events).toLowerCase()).not.toContain('nothing was charged')
    expect(JSON.stringify(events).toLowerCase()).not.toContain('did not make the order')
    expect(events.some((e) => e.t === 'paid')).toBe(false); expect((saved?.state as { purchases?: unknown[] }).purchases).toBeUndefined()
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })
  it('uses a clear card payment message when PayPal create order fails', async () => {
    const { conversations } = makeDb(); await conversations.put('conv1234', cardState(), [])
    const p = paypal((async (url: RequestInfo | URL) => String(url).endsWith('/token') ? tokenResponse() : json({}, 500)) as typeof fetch)
    const events: ScoutEvent[] = []
    await buyTurn('conv1234', 't1c1', { conversations, paypal: p, live: { model: buyModel, budget, takeVisitorBuy: async () => true }, origin: 'https://gift.test', ownerSecret: 'owner' }, async (e) => { events.push(e) }, 'card', await ownerToken('conv1234', 'owner'))
    const safe = 'PayPal could not confirm the payment. Check PayPal before trying again.'
    expect(events.filter((e) => e.t === 'result' || e.t === 'error').map((e) => e.text)).toEqual([safe, safe])
  })
  it('does not mark an incomplete capture as paid', async () => {
    const { conversations } = makeDb(); const state = cardState() as ReturnType<typeof cardState> & { purchases: { card: string; gift: string; order_id: string; amount: string; status: 'created' }[] }
    state.purchases = [{ card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '20.00', status: 'created' }]
    await conversations.put('conv1234', state, [[{ t: 'order', card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '20.00', method: 'paypal' }]])
    const response = await paidReturn(new URL('https://gift.test/paid?c=conv1234&token=ORDER123'), { conversations, paypal: { capture: async () => ({ orderId: 'ORDER123', status: 'PENDING', captureId: 'CAP1', amount: '20.00', customId: 'gs-conv1234-t1c1' }) } as never })
    expect(response.status).toBe(502); expect(await response.text()).toContain('could not confirm')
    expect((await conversations.get('conv1234'))?.turns.flat().some((e) => e.t === 'paid')).toBe(false)
  })
})

describe('Workers AI and scout stream', () => {
  it('a Workers AI error on the first or later call ends in one plain error and keeps spent neurons without inventing cards', async () => {
    // Needs runTurn's model failure handling, which is in the protected src/agent/ tree.
    for (const failAt of [1, 2]) {
      const { db, conversations } = makeDb(); const spent: number[] = []; let calls = 0
      const model = new WorkersAiModel({ async run() { calls++; if (calls === failAt) throw new Error(SECRET); return { response: 'still thinking', usage: { prompt_tokens: 100, completion_tokens: 20, neurons: 7 } } } })
      const deps: ScoutDeps = { conversations, runs: new RunCache(db), recorded: async () => [], tools: qlooTools(), live: { model, ctx: { qloo: new QlooClient('', failFetch(), new MemoryCache(), async () => true) }, budget: { allow: async () => true, reserve: async () => ({ settle: async (n) => { spent.push(n) } }) }, takeVisitorTurn: async () => true }, newId: () => `conv${failAt}123`, ownerToken: async () => 'hidden' }
      const events: ScoutEvent[] = []; await scoutTurn('A fresh request about a loved one.', undefined, deps, async (e) => { events.push(e) })
      expect(events.at(-1)?.t).toBe('done'); expect(events.at(-2)?.t).toBe('error'); expect(events.filter((e) => e.t === 'error')).toHaveLength(1)
      expect(events.some((e) => e.t === 'cards' && e.cards.length > 0)).toBe(false); expect(spent.reduce((a, b) => a + b, 0)).toBe(7 * (failAt - 1))
      expect(JSON.stringify(events)).not.toContain(SECRET)
    }
  })
  it.each([
    ['HTTP 500', async () => { throw new Error('HTTP 500 ' + SECRET) }],
    ['HTTP 429 without Retry-After', async () => { throw new Error('HTTP 429 ' + SECRET) }],
    ['HTTP 429 with Retry-After', async () => { throw new Error('HTTP 429 Retry-After ' + SECRET) }],
    ['timeout', async () => { throw new DOMException(SECRET, 'AbortError') }],
    ['non-JSON', async () => 'not JSON'], ['empty JSON', async () => ({})], ['wrong-shaped JSON', async () => ({ choices: [{ message: { content: 12 } }] })],
    ['network error', async () => { throw new TypeError(SECRET) }],
  ])('ends safely after Workers AI %s', async (_attack, upstream) => {
    const { db, conversations } = makeDb()
    const model = new WorkersAiModel({ run: async () => upstream() })
    const deps: ScoutDeps = { conversations, runs: new RunCache(db), recorded: async () => [], tools: qlooTools(), live: { model, ctx: { qloo: new QlooClient('', failFetch(), new MemoryCache(), async () => true) }, budget, takeVisitorTurn: async () => true }, newId: () => 'conv7777', ownerToken: async () => 'hidden' }
    const events: ScoutEvent[] = []; await scoutTurn('A fresh request about a loved one.', undefined, deps, async (e) => { events.push(e) })
    expect(events.at(-1)?.t).toBe('done'); expect(events.at(-2)?.t).toBe('error'); expect(events.filter((e) => e.t === 'error')).toHaveLength(1)
    expect(events.some((e) => e.t === 'cards' && e.cards.length > 0)).toBe(false); expect(JSON.stringify(events)).not.toContain(SECRET)
  })
})

describe('scout route outer catch', () => {
  it('sends one plain error as the last event and closes after a deep throw', async () => {
    const { db } = makeDb(); const pending: Promise<unknown>[] = []
    const env = { DB: db, SESSION_SECRET: 's', ASSETS: { fetch: async () => new Response('') }, COUNTERS: { idFromName: (id: string) => id, get: () => ({ take: async () => true }) } } as unknown as Env
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext
    dbs.splice(dbs.indexOf(db), 1)
    db.close() // The deep RunCache read fails after the route has already opened its NDJSON stream.
    const response = await worker.fetch(new Request('https://gift.test/api/scout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'A fresh message about someone.' }) }), env, ctx)
    const text = await response.text(); await Promise.all(pending)
    const events = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ScoutEvent)
    expect(events.at(-1)?.t).toBe('error')
    expect(events.filter((e) => e.t === 'error')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('Error:')
  })
})
