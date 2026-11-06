import { describe, expect, it, vi } from 'vitest'
import { newState, type Budget } from '../../src/agent/agent'
import { runBuyTurn } from '../../src/agent/buy'
import type { ScoutEvent } from '../../src/agent/events'
import type { Model } from '../../src/agent/model'
import { PayPal, SANDBOX_TEST_CARD } from '../../src/paypal/client'

const SHIP = { name: 'Sam', line1: '1 Main St', city: 'San Jose', state: 'CA', postal: '95131' }
const budget: Budget = { allow: async () => true, reserve: async () => ({ settle: async () => {} }) }
async function fixture() {
  let time = 0
  const state = { ...newState('retry123'), cards: [{ id: 't1c1', gift: 'A Fender strap', why: 'Music', price_low: 20, price_high: 40,
    entity: { id: 'brand', name: 'Fender', type: 'brand' }, seeds: [], from_call: 1 }] }
  const model: Model = { name: 'test', chat: vi.fn(async () => ({ content: '', prompt_tokens: 0, completion_tokens: 0,
    tool_calls: [{ id: 'buy', type: 'function' as const, function: { name: 'buy_gift', arguments: '{"card_id":"t1c1","amount_usd":30}' } }] })) }
  const createOrder = vi.fn(async (_request: unknown) => { throw new Error('lost response after capture') })
  const getOrder = vi.fn(async () => ({ id: 'ORDER123', status: 'COMPLETED', captureStatus: 'COMPLETED', captureId: 'CAPTURE1', amount: '30.00', customId: 'gs-retry123-t1c1' }))
  const paypal = Object.assign(new PayPal('test', 'test', fetch), { createOrder, getOrder })
  const events: ScoutEvent[] = []
  const options = { state, model, budget, paypal, origin: 'https://gift.test', cardId: 't1c1', method: 'card' as const,
    shipping: SHIP, now: () => time, emit: (e: ScoutEvent) => { events.push(e) } }
  const next = await runBuyTurn(options)
  events.length = 0
  return { options, next, events, createOrder, getOrder, setTime: (value: number) => { time = value } }
}

describe('review 4: safe unknown payment retries', () => {
  it.each([6, 7])('does not repost an unknown payment after %s hours', async hours => {
    const f = await fixture(); f.setTime(hours * 3600000)
    const next = await runBuyTurn({ ...f.options, state: f.next })
    expect(f.createOrder).toHaveBeenCalledTimes(1)
    expect(next.attempts?.[0].status).toBe('unknown')
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'error', text: expect.stringContaining('unresolved') }))
  })
  it.each(['shipping', 'description', 'origin', 'card details'])('does not reuse the request ID after changed %s', async changed => {
    const f = await fixture(); f.setTime(1000)
    const options = { ...f.options, state: f.next }
    if (changed === 'shipping') options.shipping = { ...SHIP, line1: '2 Other St' }
    if (changed === 'description') options.state.cards[0].gift = 'A different gift'
    if (changed === 'origin') options.origin = 'https://other.test'
    const originalName = SANDBOX_TEST_CARD.name
    try {
      if (changed === 'card details') SANDBOX_TEST_CARD.name = 'Different card holder'
      await runBuyTurn(options)
      expect(f.createOrder).toHaveBeenCalledTimes(1)
      expect(f.events).toContainEqual(expect.objectContaining({ t: 'error', text: expect.stringContaining('unresolved') }))
    } finally { SANDBOX_TEST_CARD.name = originalName }
  })
  it('reposts the identical request within the window and saves no street address', async () => {
    const f = await fixture(); f.setTime(1000)
    await runBuyTurn({ ...f.options, state: f.next, shipping: { ...SHIP } })
    expect(f.createOrder).toHaveBeenCalledTimes(2)
    expect(f.createOrder.mock.calls[1]).toEqual(f.createOrder.mock.calls[0])
    expect(f.next.attempts?.[0]).toHaveProperty('request_fingerprint', expect.stringMatching(/^[a-f0-9]{64}$/))
    expect(JSON.stringify(f.next)).not.toContain(SHIP.line1)
    expect(JSON.stringify(f.events)).not.toContain(SHIP.line1)
  })
  it('stops legacy attempts without a fingerprint', async () => {
    const f = await fixture()
    delete (f.next.attempts![0] as unknown as Record<string, unknown>).request_fingerprint
    await runBuyTurn({ ...f.options, state: f.next })
    expect(f.createOrder).toHaveBeenCalledTimes(1)
  })
  it.each(['invalid', 'future'])('stops an attempt with an %s start time', async kind => {
    const f = await fixture()
    f.next.attempts![0].at = kind === 'invalid' ? 'not a date' : new Date(1000).toISOString()
    await runBuyTurn({ ...f.options, state: f.next })
    expect(f.createOrder).toHaveBeenCalledTimes(1)
  })
  it('leaves a minute for transit at the retention boundary', async () => {
    const f = await fixture(); f.setTime(6 * 3600000 - 60000)
    await runBuyTurn({ ...f.options, state: f.next })
    expect(f.createOrder).toHaveBeenCalledTimes(1)
  })
  it('still reconciles a known order after seven hours and changed shipping', async () => {
    const f = await fixture(); f.setTime(7 * 3600000)
    f.next.attempts![0].order_id = 'ORDER123'
    const next = await runBuyTurn({ ...f.options, state: f.next, shipping: { ...SHIP, city: 'Boston' } })
    expect(f.createOrder).toHaveBeenCalledTimes(1)
    expect(f.getOrder).toHaveBeenCalledTimes(1)
    expect(next.purchases?.[0]).toMatchObject({ status: 'captured', ship_to: 'San Jose, CA' })
  })
})
