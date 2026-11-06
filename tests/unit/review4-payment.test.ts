import { afterEach, expect, it, vi } from 'vitest'
import { newState, type Budget } from '../../src/agent/agent'
import type { ScoutEvent } from '../../src/agent/events'
import type { Purchase } from '../../src/agent/buy'
import { PayPal } from '../../src/paypal/client'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const dbs: FakeD1[] = []
afterEach(() => { dbs.splice(0).forEach(db => db.close()) })
const budget: Budget = { allow: async () => true, reserve: async () => ({ settle: async () => {} }) }

async function fixture() {
  const db = new FakeD1(); dbs.push(db)
  const conversations = new Conversations(db), id = 'conflict1'
  await conversations.put(id, { ...newState(id), cards: [{ id: 't1c1', gift: 'A Fender strap', why: 'Music', price_low: 20, price_high: 40,
    entity: { id: 'brand', name: 'Fender', type: 'brand' }, seeds: [], from_call: 1 }] }, [])
  const model = { name: 'test', chat: vi.fn(async () => ({ content: '', prompt_tokens: 0, completion_tokens: 0,
    tool_calls: [{ id: 'buy', type: 'function' as const, function: { name: 'buy_gift', arguments: '{"card_id":"t1c1","amount_usd":30}' } }] })) }
  return { conversations, id, model }
}

it('coordinates creation across independent modules while a1 is open', async () => {
  const f = await fixture()
  vi.resetModules(); const first = await import('../../src/app/buy')
  vi.resetModules(); const second = await import('../../src/app/buy')
  const { PayPalError } = await import('../../src/paypal/client')
  let started!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const ids: string[] = []
  const createOrder = vi.fn(async (request: { requestId?: string }) => {
    ids.push(request.requestId!)
    if (ids.length === 1) { started(); await held }
    else if (ids.length === 2) throw new PayPalError('Request still processing', 409)
    return { id: `ORDER${ids.length}`, status: 'COMPLETED', captureStatus: 'COMPLETED', captureId: `CAP${ids.length}`, amount: '30.00' }
  })
  const deps = { ...f, ownerSecret: 'test', origin: 'https://gift.test',
    live: { model: f.model, budget, takeVisitorBuy: async () => true },
    paypal: Object.assign(new PayPal('test', 'test', fetch), { createOrder }) }
  const owner = await first.ownerToken(f.id, 'test'), events: ScoutEvent[] = []
  const send = async (e: ScoutEvent) => { events.push(e) }
  const pending = first.buyTurn(f.id, 't1c1', deps, send, 'card', owner, undefined, undefined, 30)
  await entered
  try {
    await second.buyTurn(f.id, 't1c1', deps, send, 'card', owner, undefined, undefined, 30)
    await second.buyTurn(f.id, 't1c1', deps, send, 'card', owner, undefined, undefined, 30)
    expect(ids).toEqual(['gs-conflict1-t1c1-a1'])
    expect(events.some(e => e.t === 'error' && e.text.includes('Nothing was charged'))).toBe(false)
  } finally { release(); await pending }
  const state = (await f.conversations.get(f.id))?.state as { purchases?: Purchase[] }
  expect(state.purchases).toHaveLength(1)
})

it.each([408, 409, 429])('keeps HTTP %s unresolved and retries the original request ID', async status => {
  const f = await fixture()
  const { buyTurn, ownerToken } = await import('../../src/app/buy')
  const { PayPalError } = await import('../../src/paypal/client')
  const ids: string[] = [], events: ScoutEvent[] = []
  const createOrder = vi.fn(async (request: { requestId?: string }) => {
    ids.push(request.requestId!)
    throw new PayPalError('Request still processing', status)
  })
  const deps = { ...f, ownerSecret: 'test', origin: 'https://gift.test',
    live: { model: f.model, budget, takeVisitorBuy: async () => true },
    paypal: Object.assign(new PayPal('test', 'test', fetch), { createOrder }) }
  const owner = await ownerToken(f.id, 'test')
  for (let i = 0; i < 2; i++) await buyTurn(f.id, 't1c1', deps, async e => { events.push(e) }, 'card', owner, undefined, undefined, 30)
  expect((await f.conversations.get(f.id))?.state.attempts?.[0].status).toBe('unknown')
  expect(ids).toEqual(['gs-conflict1-t1c1-a1', 'gs-conflict1-t1c1-a1'])
  expect(events.some(e => e.t === 'error' && e.text.includes('Nothing was charged'))).toBe(false)
})

it('recovers an abandoned creation claim with the same request ID after expiry', async () => {
  const f = await fixture()
  const { buyTurn, ownerToken } = await import('../../src/app/buy')
  const { PayPalError } = await import('../../src/paypal/client')
  let time = 0
  const ids: string[] = []
  const createOrder = vi.fn(async (request: { requestId?: string }) => {
    ids.push(request.requestId!)
    throw new PayPalError('Request still processing', 409)
  })
  const deps = { ...f, ownerSecret: 'test', origin: 'https://gift.test', now: () => time,
    live: { model: f.model, budget, takeVisitorBuy: async () => true },
    paypal: Object.assign(new PayPal('test', 'test', fetch), { createOrder }) }
  const owner = await ownerToken(f.id, 'test')
  const tap = () => buyTurn(f.id, 't1c1', deps, async () => {}, 'card', owner, undefined, undefined, 30)
  await tap()
  await f.conversations.update(f.id, fresh => ({ ...fresh, state: { ...fresh.state,
    attempts: fresh.state.attempts?.map(a => ({ ...a, creation_claim: { id: 'stopped-worker', until: 60_000 } })),
  } }))
  await tap()
  expect(ids).toHaveLength(1)
  time = 60_001
  await tap()
  expect(ids).toEqual(['gs-conflict1-t1c1-a1', 'gs-conflict1-t1c1-a1'])
  expect((await f.conversations.get(f.id))?.state.attempts?.[0].creation_claim).toBeUndefined()
})

