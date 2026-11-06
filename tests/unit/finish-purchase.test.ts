// The finished purchase: where the gift goes, a tracker after the capture, and a one tap refund.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newState, type Budget, type ConversationState } from '../../src/agent/agent'
import { runBuyTurn, type Attempt, type Purchase } from '../../src/agent/buy'
import type { ScoutEvent } from '../../src/agent/events'
import type { Model, ModelReply, ToolCall } from '../../src/agent/model'
import { buyTurn, handleWebhook, ownerToken, paidReturn, parseBuy, refundPurchase } from '../../src/app/buy'
import { PayPal, PayPalError } from '../../src/paypal/client'
import type { ProductResult } from '../../src/channel3/client'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const ID = 'conv1234'
const ORIGIN = 'https://gift.test'
const SECRET = 'test-secret'
const SHIP = { name: 'Sam Rivera', line1: '1 Main St', city: 'San Jose', state: 'CA', postal: '95131' }
const dbs: FakeD1[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

type State = ConversationState & { purchases?: Purchase[] }
function state(): State {
  return {
    ...newState(ID), turn: 1,
    cards: [{ id: 't1c1', gift: 'A Fender gift card', why: 'She likes music.', price_low: 20, price_high: 40,
      entity: { id: 'FENDER', name: 'Fender', type: 'brand' }, seeds: ['Phoebe Bridgers'], from_call: 1 }],
  }
}
const toolCall: ToolCall = { id: 'buy1', type: 'function', function: { name: 'buy_gift', arguments: JSON.stringify({ card_id: 't1c1', amount_usd: 30 }) } }
const reply = (calls: ToolCall[]): ModelReply => ({ content: '', tool_calls: calls, prompt_tokens: 20, completion_tokens: 5 })
function scripted(replies: ModelReply[]): Model & { calls: number } {
  const model = { name: 'scripted', calls: 0, async chat() {
    model.calls++
    const next = replies.shift(); if (!next) throw new Error('unexpected model call'); return next
  } }
  return model
}
const budget: Budget = { allow: async () => true, reserve: async () => ({ settle: async () => {} }) }
function makeDb() { const db = new FakeD1(); dbs.push(db); return new Conversations(db) }

function fetcherFor(answers: Record<string, () => Response>) {
  const sent: { url: string; body: string; method: string; requestId: string | null }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    sent.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? ''), requestId: new Headers(init?.headers).get('PayPal-Request-Id') })
    if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
    const key = Object.keys(answers).find((k) => url.endsWith(k))
    if (!key) throw new Error('unexpected ' + url)
    return answers[key]()
  }) as typeof fetch
  return { sent, fetcher }
}

/** A fake PayPal that pays card orders at once and records trackers and refunds. */
function fakePayPal(o: { trackFails?: boolean } = {}) {
  const orders: Record<string, unknown>[] = [], trackers: unknown[] = [], refunds: string[] = [], captures: string[] = []
  return {
    orders, trackers, refunds, captures,
    async createOrder(order: Record<string, unknown>) {
      orders.push(order)
      return order.card
        ? { id: 'ORDER123', status: 'COMPLETED', captureId: 'CAPTURE1' }
        : { id: 'ORDER123', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://paypal.test/approve' }
    },
    async capture(id: string) { captures.push(id); return { orderId: id, status: 'COMPLETED', captureId: 'CAPTURE1', amount: '30.00', customId: `gs-${ID}-t1c1` } },
    async addTracker(orderId: string, captureId: string, number: string) {
      if (o.trackFails) throw new PayPalError('PayPal said: UNPROCESSABLE_ENTITY', 422)
      trackers.push({ orderId, captureId, number })
      return { id: `${captureId}-${number}`, status: 'SHIPPED' }
    },
    async refund(captureId: string) { refunds.push(captureId); return { id: 'REFUND1', status: 'COMPLETED' } },
  } as unknown as PayPal & { orders: Record<string, unknown>[]; trackers: unknown[]; refunds: string[]; captures: string[] }
}

describe('PayPal client: shipping, tracker, refund', () => {
  it('reads a refund with GET and no new refund request', async () => {
    const { sent, fetcher } = fetcherFor({ '/v2/payments/refunds/R1': () => Response.json({ id: 'R1', status: 'PENDING' }) })
    expect(await new PayPal('id', 'secret', fetcher).getRefund('R1')).toEqual({ id: 'R1', status: 'PENDING' })
    expect(sent[1]).toMatchObject({ method: 'GET', body: '', requestId: null })
  })

  it('reads the completed capture and custom id from an order', async () => {
    const { sent, fetcher } = fetcherFor({ '/v2/checkout/orders/O1': () => Response.json({ id: 'O1', status: 'COMPLETED', purchase_units: [{ custom_id: 'gs-conv1234-t1c1', payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { value: '30.00' } }] } }] }) })
    expect(await new PayPal('id', 'secret', fetcher).getOrder('O1')).toEqual({ id: 'O1', status: 'COMPLETED', captureId: 'C1', captureStatus: 'COMPLETED', amount: '30.00', customId: 'gs-conv1234-t1c1' })
    expect(sent[1]).toMatchObject({ method: 'GET', body: '', requestId: null })
  })

  it.each([null, { id: 'O1', status: 'COMPLETED' }, { id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{}] } }] }])('rejects an incomplete order read %j', async (body) => {
    const { fetcher } = fetcherFor({ '/v2/checkout/orders/O1': () => Response.json(body) })
    await expect(new PayPal('id', 'secret', fetcher).getOrder('O1')).rejects.toBeInstanceOf(PayPalError)
  })

  it('puts the address on the order and asks PayPal to use it', async () => {
    const { sent, fetcher } = fetcherFor({ '/v2/checkout/orders': () => new Response(JSON.stringify({ id: 'O1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://p' }] })) })
    await new PayPal('id', 'secret', fetcher).createOrder({ amount: '30.00', customId: 'gs-x-t1c1', description: 'd', returnUrl: 'r', cancelUrl: 'c', requestId: 'q', shipping: SHIP })
    const body = JSON.parse(sent[1].body)
    expect(body.purchase_units[0].shipping).toEqual({ type: 'SHIPPING', name: { full_name: 'Sam Rivera' },
      address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } })
    expect(body.payment_source.paypal.experience_context.shipping_preference).toBe('SET_PROVIDED_ADDRESS')
  })

  it('keeps NO_SHIPPING when no address is given', async () => {
    const { sent, fetcher } = fetcherFor({ '/v2/checkout/orders': () => new Response(JSON.stringify({ id: 'O1', status: 'PAYER_ACTION_REQUIRED', links: [] })) })
    await new PayPal('id', 'secret', fetcher).createOrder({ amount: '30.00', customId: 'gs-x-t1c1', description: 'd', returnUrl: 'r', cancelUrl: 'c', requestId: 'q' })
    const body = JSON.parse(sent[1].body)
    expect(body.purchase_units[0].shipping).toBeUndefined()
    expect(body.payment_source.paypal.experience_context.shipping_preference).toBe('NO_SHIPPING')
  })

  it('adds a tracker to the capture and reads its id', async () => {
    const { sent, fetcher } = fetcherFor({ '/v2/checkout/orders/O1/track': () => new Response(JSON.stringify({ id: 'O1', purchase_units: [{ shipping: { trackers: [{ id: 'C1-GSC1', status: 'SHIPPED' }] } }] }), { status: 201 }) })
    const tracker = await new PayPal('id', 'secret', fetcher).addTracker('O1', 'C1', 'GSC1')
    expect(JSON.parse(sent[1].body)).toEqual({ capture_id: 'C1', tracking_number: 'GSC1', carrier: 'OTHER', carrier_name_other: 'Gift Scout sandbox', notify_payer: false })
    expect(sent[1].requestId).toBe('track-C1')
    expect(tracker).toEqual({ id: 'C1-GSC1', status: 'SHIPPED' })
  })

  it('refunds a capture in full, once per capture', async () => {
    const { sent, fetcher } = fetcherFor({ '/v2/payments/captures/C1/refund': () => new Response(JSON.stringify({ id: 'R1', status: 'COMPLETED' }), { status: 201 }) })
    const refund = await new PayPal('id', 'secret', fetcher).refund('C1')
    expect(JSON.parse(sent[1].body)).toEqual({})
    expect(sent[1].requestId).toBe('refund-C1')
    expect(refund).toEqual({ id: 'R1', status: 'COMPLETED' })
  })
})

describe('the ship to address on a buy', () => {
  const request = (body: unknown) => new Request('https://gift.test/api/buy', { method: 'POST', body: JSON.stringify(body) })
  it('reads a US address', async () => {
    expect(await parseBuy(request({ conversation: ID, card: 't1c1', ship: SHIP }))).toMatchObject({ ship: SHIP })
  })
  it('refuses a malformed address', async () => {
    for (const bad of [{ ...SHIP, state: 'California' }, { ...SHIP, postal: '9513' }, { ...SHIP, name: '' }, { ...SHIP, line1: 'x'.repeat(101) }, 'San Jose']) {
      expect(await parseBuy(request({ conversation: ID, card: 't1c1', ship: bad }))).toBeNull()
    }
  })
})

describe('a buy that ships', () => {
  it('pays with the test card, adds a tracker, and keeps only the city on the conversation', async () => {
    const paypal = fakePayPal(), events: ScoutEvent[] = []
    const next = await runBuyTurn({ cardId: 't1c1', method: 'card', shipping: SHIP, state: state(), model: scripted([reply([toolCall])]), budget, paypal, origin: ORIGIN, now: () => 0, emit: (e) => { events.push(e) } })
    expect(events.map((e) => e.t)).toEqual(['call', 'result', 'order', 'paid', 'shipped', 'usage'])
    expect(paypal.orders[0].shipping).toEqual(SHIP)
    expect(events.find((e) => e.t === 'shipped')).toMatchObject({ order_id: 'ORDER123', capture_id: 'CAPTURE1', tracker_id: 'CAPTURE1-GSCAPTURE1', tracking_number: 'GSCAPTURE1', ship_to: 'San Jose, CA' })
    expect(next.purchases).toMatchObject([{ status: 'captured', ship_to: 'San Jose, CA', tracker_id: 'CAPTURE1-GSCAPTURE1' }])
    expect(JSON.stringify(next)).not.toContain('1 Main St')
    expect(JSON.stringify(events)).not.toContain('1 Main St')
  })

  it('still shows the payment when the tracker fails, and says it is not tracked', async () => {
    const paypal = fakePayPal({ trackFails: true }), events: ScoutEvent[] = []
    const next = await runBuyTurn({ cardId: 't1c1', method: 'card', shipping: SHIP, state: state(), model: scripted([reply([toolCall])]), budget, paypal, origin: ORIGIN, now: () => 0, emit: (e) => { events.push(e) } })
    expect(events.map((e) => e.t)).toEqual(['call', 'result', 'order', 'paid', 'usage'])
    expect(next.purchases).toMatchObject([{ status: 'captured' }])
    expect(next.purchases?.[0].tracker_id).toBeUndefined()
  })

  it('adds the tracker when the buyer comes back from PayPal', async () => {
    const conversations = makeDb(), s = state()
    s.purchases = [{ card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', status: 'created', ship_to: 'San Jose, CA' }]
    await conversations.put(ID, s, [[{ t: 'run', conversation: ID, turn: 1, mode: 'live', purpose: 'buy' }, { t: 'order', card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', approve_url: 'https://paypal.test/pay' }]])
    const paypal = fakePayPal()
    const res = await paidReturn(new URL(`https://gift.test/paid?c=${ID}&token=ORDER123`), { conversations, paypal, now: () => 1000 })
    expect(res.status).toBe(303)
    const saved = await conversations.get(ID)
    expect(saved?.turns[0].map((e) => e.t)).toEqual(['run', 'order', 'paid', 'shipped'])
    expect(saved?.state).toMatchObject({ purchases: [{ status: 'captured', tracker_id: 'CAPTURE1-GSCAPTURE1' }] })
  })

  it('adds no tracker to an order made without an address', async () => {
    const conversations = makeDb(), s = state()
    s.purchases = [{ card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', status: 'created' }]
    await conversations.put(ID, s, [[{ t: 'order', card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', approve_url: 'https://paypal.test/pay' }]])
    const paypal = fakePayPal()
    await paidReturn(new URL(`https://gift.test/paid?c=${ID}&token=ORDER123`), { conversations, paypal, now: () => 1000 })
    expect(paypal.trackers).toHaveLength(0)
    expect((await conversations.get(ID))?.turns[0].map((e) => e.t)).toEqual(['order', 'paid'])
  })
})

describe('changed my mind: the one tap refund', () => {
  it('keeps a concurrent turn while the refund is pending', async () => {
    const conversations = await paidConversation(), paypal = fakePayPal()
    paypal.refund = async () => {
      await conversations.update(ID, (fresh) => ({ state: { ...fresh.state, turn: 2 }, turns: [...fresh.turns, [{ t: 'say', text: 'Another turn' }]] }))
      return { id: 'REFUND1', status: 'COMPLETED' }
    }
    const out = await refundPurchase({ conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }, { conversations, paypal, ownerSecret: SECRET })
    expect(out.status).toBe(200)
    const saved = (await conversations.get(ID))!
    expect(saved.state).toMatchObject({ turn: 2, purchases: [{ status: 'refunded' }] })
    expect(saved.turns.at(-1)).toEqual([{ t: 'say', text: 'Another turn' }])
    expect(saved.turns.flat().filter((e) => e.t === 'refunded')).toHaveLength(1)
  })

  it('saves payment before tracking and keeps a turn written while tracking', async () => {
    const conversations = makeDb(), s = state(), paypal = fakePayPal()
    s.purchases = [{ card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00', status: 'created', ship_to: 'San Jose, CA' }]
    await conversations.put(ID, s, [[{ t: 'order', card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00' }]])
    paypal.addTracker = async () => {
      expect((await conversations.get(ID))?.state).toMatchObject({ purchases: [{ status: 'captured' }] })
      await conversations.update(ID, (fresh) => ({ state: { ...fresh.state, turn: 2 }, turns: [...fresh.turns, [{ t: 'say', text: 'Another turn' }]] }))
      return { id: 'TRACK1', status: 'SHIPPED' }
    }
    expect((await paidReturn(new URL(`${ORIGIN}/paid?c=${ID}&token=ORDER123`), { conversations, paypal })).status).toBe(303)
    const saved = (await conversations.get(ID))!
    expect(saved.state).toMatchObject({ turn: 2, purchases: [{ status: 'captured', tracker_id: 'TRACK1' }] })
    expect(saved.turns.at(-1)).toEqual([{ t: 'say', text: 'Another turn' }])
    expect(saved.turns[0].map((e) => e.t)).toEqual(['order', 'paid', 'shipped'])
  })
  async function paidConversation() {
    const conversations = makeDb(), s = state()
    s.purchases = [{ card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', status: 'captured', capture_id: 'CAPTURE1', at: 'x' }]
    await conversations.put(ID, s, [[{ t: 'say', text: 'cards' }], [{ t: 'run', conversation: ID, turn: 1, mode: 'live', purpose: 'buy' }, { t: 'paid', card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', capture_id: 'CAPTURE1', amount: '30.00', at: 'x' }]])
    return conversations
  }

  it('keeps a pending refund pending without a refunded event', async () => {
    const conversations = await paidConversation(), paypal = fakePayPal()
    paypal.refund = async (id) => { paypal.refunds.push(id); return { id: 'REFUND1', status: 'PENDING' } }
    const out = await refundPurchase({ conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }, { conversations, paypal, ownerSecret: SECRET })
    expect(out.status).toBe(202)
    expect(out.event).toMatchObject({ t: 'refund_pending', refund_id: 'REFUND1' })
    const saved = (await conversations.get(ID))!
    expect(saved.state).toMatchObject({ purchases: [{ status: 'refund_pending', refund_id: 'REFUND1' }] })
    expect(saved.turns[1].map(e => e.t)).toEqual(['run', 'paid', 'refund_pending'])
  })

  it.each(['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED'])('reads an existing pending refund that is now %s', async (status) => {
    const conversations = await paidConversation(), paypal = fakePayPal(), reads: string[] = []
    paypal.refund = async (id) => { paypal.refunds.push(id); return { id: 'REFUND1', status: 'PENDING' } }
    Object.assign(paypal, { getRefund: async (id: string) => { reads.push(id); return { id, status } } })
    const req = { conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }
    const deps = { conversations, paypal, ownerSecret: SECRET }
    await refundPurchase(req, deps)
    const out = await refundPurchase(req, deps)
    expect(reads).toEqual(['REFUND1'])
    expect(paypal.refunds).toEqual(['CAPTURE1'])
    const expected = status === 'COMPLETED' ? 'refunded' : status === 'PENDING' ? 'refund_pending' : 'captured'
    expect((await conversations.get(ID))!.state).toMatchObject({ purchases: [{ status: expected }] })
    if (status === 'PENDING') {
      expect(out.status).toBe(202)
      expect(out.error).toBe('PayPal is still working on the refund.')
    } else {
      expect(out.event?.t).toBe(status === 'COMPLETED' ? 'refunded' : 'refund_failed')
      expect((await conversations.get(ID))!.turns[1].at(-1)?.t).toBe(out.event?.t)
      if (status !== 'COMPLETED') expect(out.error).toBe('PayPal did not complete the refund. The payment stands.')
    }
  })

  it('serializes two taps while the refund is pending', async () => {
    const conversations = await paidConversation(), paypal = fakePayPal(), reads: string[] = []
    paypal.refund = async (id) => { paypal.refunds.push(id); return { id: 'REFUND1', status: 'PENDING' } }
    Object.assign(paypal, { getRefund: async (id: string) => { reads.push(id); return { id, status: 'PENDING' } } })
    const req = { conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }
    const deps = { conversations, paypal, ownerSecret: SECRET }
    expect((await Promise.all([refundPurchase(req, deps), refundPurchase(req, deps)])).map(out => out.status)).toEqual([202, 202])
    expect(paypal.refunds).toEqual(['CAPTURE1'])
    expect(reads).toEqual(['REFUND1'])
    expect((await conversations.get(ID))!.turns[1].map(e => e.t)).toEqual(['run', 'paid', 'refund_pending'])
  })

  it('keeps the pending refund when its status read fails', async () => {
    const conversations = await paidConversation(), paypal = fakePayPal()
    paypal.refund = async (id) => { paypal.refunds.push(id); return { id: 'REFUND1', status: 'PENDING' } }
    Object.assign(paypal, { getRefund: async () => { throw new Error('timeout') } })
    const req = { conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }
    const deps = { conversations, paypal, ownerSecret: SECRET }
    await refundPurchase(req, deps)
    const before = await conversations.get(ID)
    expect((await refundPurchase(req, deps)).error).toBe('PayPal did not answer. Tap again to check; it will not refund twice.')
    expect(await conversations.get(ID)).toEqual(before)
    expect(paypal.refunds).toEqual(['CAPTURE1'])
  })

  it('does not buy a gift while its refund is pending', async () => {
    const s = state(), model = scripted([]), paypal = fakePayPal(), events: ScoutEvent[] = []
    s.purchases = [{ card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00', status: 'refund_pending', capture_id: 'CAPTURE1', refund_id: 'REFUND1' }]
    await runBuyTurn({ cardId: 't1c1', state: s, model, budget, paypal, origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(model.calls).toBe(0)
    expect(paypal.orders).toHaveLength(0)
    expect(events).toMatchObject([{ t: 'error', text: 'That gift has already been paid for.' }])
  })

  it('uses honest words when a refund answer is lost', async () => {
    const conversations = await paidConversation(), paypal = fakePayPal()
    paypal.refund = async () => { throw new Error('timeout') }
    const out = await refundPurchase({ conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }, { conversations, paypal, ownerSecret: SECRET })
    expect(out.error).toBe('PayPal did not answer. Tap again to check; it will not refund twice.')
  })

  it('refunds the capture, marks the purchase refunded, and shows it beside the payment', async () => {
    const conversations = await paidConversation(), paypal = fakePayPal()
    const out = await refundPurchase({ conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }, { conversations, paypal, ownerSecret: SECRET, now: () => 0 })
    expect(out.status).toBe(200)
    expect(out.event).toMatchObject({ t: 'refunded', card: 't1c1', capture_id: 'CAPTURE1', refund_id: 'REFUND1', amount: '30.00' })
    expect(paypal.refunds).toEqual(['CAPTURE1'])
    const saved = await conversations.get(ID)
    expect(saved?.state).toMatchObject({ purchases: [{ status: 'refunded', refund_id: 'REFUND1' }] })
    expect(saved?.turns[1].map((e) => e.t)).toEqual(['run', 'paid', 'refunded'])
    expect(saved?.turns[0].map((e) => e.t)).toEqual(['say'])
  })

  it('refunds only once', async () => {
    const conversations = await paidConversation(), paypal = fakePayPal(), owner = await ownerToken(ID, SECRET)
    await refundPurchase({ conversation: ID, card: 't1c1', owner }, { conversations, paypal, ownerSecret: SECRET })
    const again = await refundPurchase({ conversation: ID, card: 't1c1', owner }, { conversations, paypal, ownerSecret: SECRET })
    expect(again.status).toBe(409)
    expect(paypal.refunds).toHaveLength(1)
  })

  it('refuses anyone but the tab that started the conversation', async () => {
    const conversations = await paidConversation(), paypal = fakePayPal()
    const out = await refundPurchase({ conversation: ID, card: 't1c1', owner: '0'.repeat(64) }, { conversations, paypal, ownerSecret: SECRET })
    expect(out.status).toBe(403)
    expect(paypal.refunds).toHaveLength(0)
  })

  it('refuses a gift that was never paid', async () => {
    const conversations = makeDb(), s = state()
    s.purchases = [{ card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', status: 'created' }]
    await conversations.put(ID, s, [])
    const paypal = fakePayPal()
    const out = await refundPurchase({ conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }, { conversations, paypal, ownerSecret: SECRET })
    expect(out.status).toBe(409)
    expect(paypal.refunds).toHaveLength(0)
  })

  it('saves nothing when PayPal refuses the refund', async () => {
    const conversations = await paidConversation(), paypal = fakePayPal(), before = await conversations.get(ID)
    paypal.refund = (async () => { throw new PayPalError('PayPal said: CAPTURE_FULLY_REFUNDED', 422) }) as typeof paypal.refund
    const out = await refundPurchase({ conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }, { conversations, paypal, ownerSecret: SECRET })
    expect(out.status).toBe(502)
    expect(await conversations.get(ID)).toEqual(before)
  })

  it('does not buy a refunded gift again', async () => {
    const s = state(), model = scripted([]), paypal = fakePayPal(), events: ScoutEvent[] = []
    s.purchases = [{ card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', status: 'refunded', capture_id: 'CAPTURE1', refund_id: 'REFUND1' }]
    await runBuyTurn({ cardId: 't1c1', method: 'card', state: s, model, budget, paypal, origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(model.calls).toBe(0)
    expect(paypal.orders).toHaveLength(0)
    expect(events).toMatchObject([{ t: 'error', text: 'That gift was refunded.' }])
  })
})

describe('the return message page', () => {
  it('keeps the bad link status and words in a styled heading', async () => {
    const response = await paidReturn(new URL('https://gift.test/paid?c=bad&token=bad'), { conversations: makeDb(), paypal: fakePayPal() });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('<h1>That link is not one Gift Scout made.</h1>');
    expect(html).toContain('href="/style.css"');
    expect(html).not.toMatch(/style\s*=/i);
  });
});


describe('capture recovery', () => {
  it.each(['completed', 'empty', 'unavailable', 'pending', 'wrong card', 'wrong amount'])('checks the order after a lost capture answer: %s', async (answer) => {
    const conversations = makeDb(), s = state(), paypal = fakePayPal(), reads: string[] = []
    s.purchases = [{ card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00', status: 'created' }]
    await conversations.put(ID, s, [[{ t: 'order', card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00' }]])
    paypal.capture = async () => { throw new PayPalError('server error', 500) }
    Object.assign(paypal, { getOrder: async (id: string) => {
      reads.push(id)
      if (answer === 'unavailable') throw new Error('timeout')
      return { id, status: answer === 'empty' ? 'APPROVED' : 'COMPLETED', ...(answer === 'empty' ? {} : {
        captureId: 'CAPTURE1', captureStatus: answer === 'pending' ? 'PENDING' : 'COMPLETED',
        customId: answer === 'wrong card' ? 'gs-other-t1c1' : `gs-${ID}-t1c1`, amount: answer === 'wrong amount' ? '31.00' : '30.00',
      }) }
    } })
    const response = await paidReturn(new URL(`${ORIGIN}/paid?c=${ID}&token=ORDER123`), { conversations, paypal })
    expect(reads).toEqual(['ORDER123'])
    const saved = (await conversations.get(ID))!
    if (answer === 'completed') {
      expect(response.status).toBe(303)
      expect(saved.state).toMatchObject({ purchases: [{ status: 'captured', capture_id: 'CAPTURE1' }] })
      expect(saved.turns[0].map(e => e.t)).toEqual(['order', 'paid'])
    } else {
      const html = await response.text()
      expect(saved.state).toMatchObject({ purchases: [{ status: 'created' }] })
      if (answer === 'empty') expect(html).toContain('Nothing was charged')
      else expect(html).not.toContain('Nothing was charged')
      if (answer === 'unavailable' || answer === 'pending') {
        expect(response.status).toBe(502)
        expect(html).toContain('PayPal did not confirm the payment yet. Open this link again in a minute, or check PayPal.')
      }
    }
  })
})


describe('fresh offer before payment', () => {
  async function setup() {
    const conversations = makeDb(), s = state(), paypal = fakePayPal()
    s.cards[0].gift = 'A Fender strap'
    s.cards[0].product = { id: 'product-1', title: 'Fender strap', price: 20, currency: 'USD', url: 'https://shop.test/item', source: 'channel3' }
    await conversations.put(ID, s, [[{ t: 'cards', cards: s.cards, dropped: [] }]])
    const model = scripted([reply([{ ...toolCall, function: { name: 'buy_gift', arguments: JSON.stringify({ card_id: 't1c1', amount_usd: 24 }) } }])])
    const takeVisitorBuy = vi.fn(async () => true)
    const product = vi.fn(async (_id: string): Promise<ProductResult> => ({ ok: true as const, product: { id: 'product-1', title: 'Fender strap', price: 24, currency: 'USD', url: 'https://shop.test/item' } }))
    const events: ScoutEvent[] = []
    const deps = { conversations, paypal, products: { product }, live: { model, budget, takeVisitorBuy }, origin: ORIGIN, ownerSecret: SECRET }
    const tap = async () => buyTurn(ID, 't1c1', deps, async e => { events.push(e) }, 'paypal', await ownerToken(ID, SECRET), undefined, (await conversations.get(ID))!.state.cards[0].product as { id: string; price: number; title: string; url: string })
    return { conversations, paypal, model, takeVisitorBuy, product, events, deps, tap }
  }
  it('saves the new price, stops, then pays the new amount on the next tap', async () => {
    const f = await setup()
    await f.tap()
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.model.calls).toBe(0)
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
    expect((await f.conversations.get(ID))?.state.cards[0].product?.price).toBe(24)
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'offer_changed', card: 't1c1', title: 'Fender strap', old_price: 20, new_price: 24, changes: ['price'] }))
    expect((await f.conversations.get(ID))?.turns.flat()).toContainEqual(f.events.find(e => e.t === 'offer_changed'))
    await f.tap()
    expect(f.product).toHaveBeenCalledTimes(2)
    expect(f.paypal.orders).toMatchObject([{ amount: '24.00' }])
    expect(f.takeVisitorBuy).toHaveBeenCalledTimes(1)
  })
  it('removes a gone offer and keeps the idea without ordering', async () => {
    const f = await setup()
    f.deps.products = { product: vi.fn(async () => ({ ok: false, reason: 'gone' })) }
    await f.tap()
    expect(f.paypal.orders).toHaveLength(0)
    expect((await f.conversations.get(ID))?.state.cards[0].product).toBeUndefined()
    expect(f.events).toContainEqual({ t: 'offer_gone', card: 't1c1', title: 'Fender strap' })
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
  })
  it('removes an offer that rose above the card budget and keeps the idea', async () => {
    const f = await setup()
    f.deps.products = { product: vi.fn(async () => ({ ok: true as const, product: { id: 'product-1', title: 'Fender strap', price: 41, currency: 'USD', url: 'https://shop.test/item' } })) }
    await f.tap()
    expect(f.paypal.orders).toHaveLength(0)
    expect((await f.conversations.get(ID))?.state.cards[0].product).toBeUndefined()
    expect(f.events).toContainEqual({ t: 'offer_gone', card: 't1c1', title: 'Fender strap', reason: 'over_budget', new_price: 41 })
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
    expect(f.model.calls).toBe(0)
  })
  it.each(['off', 'capped', 'spent', 'error'] as const)('stops on %s without a model, order or buy counter', async (reason) => {
    const f = await setup()
    f.deps.products = { product: vi.fn(async () => ({ ok: false, reason })) }
    await f.tap()
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.model.calls).toBe(0)
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
    expect(f.events).toContainEqual({ t: 'error', text: 'We could not check the price just now. Nothing was charged.' })
  })
  it('checks the same price once before ordering', async () => {
    const f = await setup()
    await f.conversations.update(ID, saved => { saved.state.cards[0].product!.price = 24; return saved })
    await f.tap()
    expect(f.product).toHaveBeenCalledExactlyOnceWith('product-1')
    expect(f.paypal.orders).toMatchObject([{ amount: '24.00' }])
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'call', tool: 'check_offer' }))
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'result', tool: 'check_offer', ok: true, cached: false }))
  })
})


describe('the exact offer shown before the tap', () => {
  const original = { id: 'p1', title: 'Fallen Angel', price: 20, currency: 'USD', url: 'https://shop.test/book', source: 'channel3' as const }
  async function setup(fresh: typeof original & { brand?: string } = original, saved: typeof original = original) {
    const conversations = makeDb(), s = state(), paypal = fakePayPal()
    s.cards[0].entity = { id: 'BOOK', name: 'Fallen Angel', type: 'book' }
    s.cards[0].gift = 'A Fallen Angel book'
    s.cards[0].product = saved
    await conversations.put(ID, s, [[{ t: 'cards', cards: s.cards, dropped: [] }]])
    const product = vi.fn(async (): Promise<ProductResult> => ({ ok: true, product: fresh }))
    const takeVisitorBuy = vi.fn(async () => true)
    const model = scripted([reply([{ ...toolCall, function: { name: 'buy_gift', arguments: JSON.stringify({ card_id: 't1c1', amount_usd: 20 }) } }])])
    const deps = { conversations, paypal, products: { product }, live: { model, budget, takeVisitorBuy }, origin: ORIGIN, ownerSecret: SECRET }
    const events: ScoutEvent[] = []
    const tap = async (offer?: { id: string; title: string; price: number; url: string }) => buyTurn(ID, 't1c1', deps, async e => { events.push(e) }, 'paypal', await ownerToken(ID, SECRET), undefined, offer)
    return { conversations, paypal, product, takeVisitorBuy, model, events, tap }
  }
  it.each(['https://shop.test/book-b', 'https://shop.test/book?variant=blue', 'https://shop.test/book#edition-two'])('review 2: reconfirms a changed offer URL %s', async url => {
    const fresh = { ...original, url }
    const f = await setup(fresh)
    await f.tap(original)
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.model.calls).toBe(0)
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'offer_changed', changes: ['offer'] }))
    await f.tap(fresh)
    expect(f.paypal.orders).toHaveLength(1)
  })
  it('review 2: rejects a stale same host snapshot before checking products', async () => {
    const f = await setup()
    await f.tap({ ...original, url: 'https://shop.test/book?variant=old' })
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.product).not.toHaveBeenCalled()
  })
  it('review 2: ignores only listed tracking parameters and parameter order', async () => {
    const f = await setup({ ...original, url: original.url + '?utm_source=newsletter&gclid=click' })
    await f.tap(original)
    expect(f.paypal.orders).toHaveLength(1)
  })
  it('ignores the Channel3 aid parameter, which is new on every product read', async () => {
    const link = 'https://buy.trychannel3.com/Wgly64m-i2yC-HE0Wiz?o=01M5QN352X8Y1H73EK8M04MX25&aid='
    const saved = { ...original, url: link + '01M6S6RG5MQ4G6JN3GPKGCRC3W' }
    const f = await setup({ ...saved, url: link + '01M6S6RH31NVQM2QNDXT304939' }, saved)
    await f.tap(saved)
    expect(f.events.some(e => e.t === 'offer_changed')).toBe(false)
    expect(f.paypal.orders).toHaveLength(1)
  })
  it('still stops a Channel3 link that points at another offer', async () => {
    const saved = { ...original, url: 'https://buy.trychannel3.com/Wgly64m-i2yC-HE0Wiz?o=AAA&aid=1' }
    const f = await setup({ ...saved, url: 'https://buy.trychannel3.com/Wgly64m-i2yC-HE0Wiz?o=BBB&aid=2' }, saved)
    await f.tap(saved)
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'offer_changed', changes: ['offer'] }))
  })
  it('removes a book offer that became a poster at the same price', async () => {
    const f = await setup({ ...original, title: 'Fallen Angel poster' })
    await f.tap(original)
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.events).toContainEqual({ t: 'offer_gone', card: 't1c1', title: original.title })
    expect((await f.conversations.get(ID))?.state.cards[0].product).toBeUndefined()
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
  })
  it('saves a changed title and shop and pays only after the new snapshot', async () => {
    const fresh = { ...original, title: 'Fallen Angel (Deluxe Edition)', url: 'https://other.test/book' }
    const f = await setup(fresh)
    await f.tap(original)
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'offer_changed', changes: ['title', 'shop'], old_title: original.title, new_title: fresh.title, shop: 'other.test' }))
    expect((await f.conversations.get(ID))?.state.cards[0].product).toMatchObject(fresh)
    expect((await f.conversations.get(ID))?.turns.flat()).toContainEqual(f.events.find(e => e.t === 'offer_changed'))
    await f.tap(fresh)
    expect(f.paypal.orders).toMatchObject([{ amount: '20.00' }])
  })
  it.each([
    { ...original, title: 'Fallen Angel (Deluxe Edition)', brand: 'Paper Bound' },
    { ...original, url: 'https://other.test/book' },
  ])('requires a second tap when only title or shop changes: %j', async fresh => {
    const f = await setup(fresh)
    await f.tap(original)
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'offer_changed', changes: [fresh.title !== original.title ? 'title' : 'shop'] }))
    expect((await f.conversations.get(ID))?.state.cards[0].product).toMatchObject(fresh)
    await f.tap(fresh)
    expect(f.paypal.orders).toMatchObject([{ amount: '20.00' }])
  })
  it('folds title case and punctuation and saves plain titles and brand names on a change', async () => {
    const f = await setup({ ...original, title: 'FALLEN ANGEL' })
    await f.tap(original)
    expect(f.paypal.orders).toHaveLength(1)
    expect(f.events.some(e => e.t === 'offer_changed')).toBe(false)
    const changed = await setup({ ...original, title: 'Fallen Angel (Deluxe-Edition)', brand: 'Paper-Bound' } as typeof original)
    await changed.tap(original)
    expect((await changed.conversations.get(ID))?.state.cards[0].product).toMatchObject({ title: 'Fallen Angel (Deluxe Edition)', brand: 'Paper Bound' })
  })
  it.each([undefined, { ...original, price: 18 }, { ...original, id: 'old' }, { ...original, title: 'Old title' }, { ...original, url: 'https://old.test/book' }])('stops a stale or missing snapshot %j before any counter', async offer => {
    const f = await setup()
    await f.tap(offer)
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.product).not.toHaveBeenCalled()
    expect(f.model.calls).toBe(0)
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
    expect((await f.conversations.get(ID))?.state.calls).toBe(0)
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'offer_changed', new_price: 20 }))
  })
  it.each([undefined, 22, 25])('requires the displayed idea quote %s', async quote => {
    const conversations = makeDb(), s = state(), paypal = fakePayPal()
    s.cards[0].price_high = 30
    await conversations.put(ID, s, [])
    const model = scripted([reply([{ ...toolCall, function: { name: 'buy_gift', arguments: JSON.stringify({ card_id: 't1c1', amount_usd: 25 }) } }])])
    const takeVisitorBuy = vi.fn(async () => true), events: ScoutEvent[] = []
    await buyTurn(ID, 't1c1', { conversations, paypal, live: { model, budget, takeVisitorBuy }, origin: ORIGIN, ownerSecret: SECRET }, async e => { events.push(e) }, 'paypal', await ownerToken(ID, SECRET), undefined, undefined, quote)
    if (quote === 25) expect(paypal.orders).toMatchObject([{ amount: '25.00' }])
    else {
      expect(paypal.orders).toHaveLength(0)
      expect(model.calls).toBe(0)
      expect(takeVisitorBuy).not.toHaveBeenCalled()
      expect(events).toContainEqual({ t: 'offer_changed', card: 't1c1', title: s.cards[0].gift, old_price: quote ?? 0, new_price: 25 })
    }
  })
})


describe('payment snapshot parsing', () => {
  const offer = { id: 'p', title: 'Book', url: 'https://shop.test/book', price: 20 }
  const parse = (extra: Record<string, unknown>) => parseBuy(new Request('https://gift.test/api/buy', { method: 'POST', body: JSON.stringify({ conversation: ID, card: 't1c1', ...extra }) }))
  it('reads the displayed product and idea quote', async () => {
    expect(await parse({ offer })).toMatchObject({ offer })
    expect(await parse({ quote: 25 })).toMatchObject({ quote: 25 })
  })
  it.each(['id', 'title', 'url'])('rejects invalid snapshot %s values', async field => {
    for (const value of [null, 42, '', 'x'.repeat(400)]) expect(await parse({ offer: { ...offer, [field]: value } })).toBeNull()
  })
  it.each([null, [], 'offer', { ...offer, price: '20' }, { ...offer, price: null }])('rejects malformed snapshot %j', async offer => {
    expect(await parse({ offer })).toBeNull()
  })
  it.each([null, '25'])('rejects an invalid quote %j', async quote => {
    expect(await parse({ quote })).toBeNull()
  })
  it('rejects nonfinite amounts', async () => {
    for (const price of ['1e999', '-1e999']) {
      const body = `{"conversation":"${ID}","card":"t1c1","offer":{"id":"p","title":"Book","url":"https://shop.test/book","price":${price}}}`
      expect(await parseBuy(new Request('https://gift.test/api/buy', { method: 'POST', body }))).toBeNull()
      expect(await parseBuy(new Request('https://gift.test/api/buy', { method: 'POST', body: `{"conversation":"${ID}","card":"t1c1","quote":${price}}` }))).toBeNull()
    }
  })
})

describe('payment attempt recovery', () => {
  const attempt = (extra: Partial<Attempt> = {}): Attempt => ({ card: 't1c1', request_id: `gs-${ID}-t1c1-a1`, amount: '30.00', method: 'card', status: 'unknown', at: new Date(0).toISOString(), ...extra })
  const captureBody = (extra: Record<string, unknown> = {}) => ({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE1', status: 'COMPLETED', custom_id: `gs-${ID}-t1c1`, amount: { value: '30.00' }, supplementary_data: { related_ids: { order_id: 'ORDER123' } }, ...extra } })
  const deliver = (conversations: Conversations, paypal: PayPal, body = captureBody()) => handleWebhook(new Request(`${ORIGIN}/api/paypal/webhook`, { method: 'POST', body: JSON.stringify(body) }), { conversations, paypal, webhookId: 'wh' })
  async function setup(s = state()) {
    const conversations = makeDb(), paypal = fakePayPal(), events: ScoutEvent[] = []
    await conversations.put(ID, s, [[{ t: 'say', text: 'prior turn' }]])
    const model = scripted([reply([toolCall]), reply([{ ...toolCall, function: { name: 'buy_gift', arguments: JSON.stringify({ card_id: 't1c1', amount_usd: 35 }) } }])])
    const takeVisitorBuy = vi.fn(async () => true)
    const deps = { conversations, paypal, live: { model, budget, takeVisitorBuy }, origin: ORIGIN, ownerSecret: SECRET }
    const tap = async (method: 'card' | 'paypal' = 'card', quote: number | undefined = 30) => buyTurn(ID, 't1c1', deps, async e => { events.push(e) }, method, await ownerToken(ID, SECRET), undefined, undefined, quote)
    return { conversations, paypal, events, model, takeVisitorBuy, deps, tap }
  }

  it('saves an unknown attempt and replays the same request without another model call or counter', async () => {
    const f = await setup()
    f.paypal.createOrder = async o => {
      f.paypal.orders.push(o)
      const saved = await f.conversations.get(ID)
      expect(saved?.state).toMatchObject({ attempts: [attempt({ status: 'sent', at: expect.any(String) })] })
      expect(saved?.turns[0]).toEqual([{ t: 'say', text: 'prior turn' }])
      if (f.paypal.orders.length === 1) throw new Error('timeout after request')
      return { id: 'ORDER123', status: 'COMPLETED', captureId: 'CAPTURE1' }
    }
    await f.tap()
    expect((await f.conversations.get(ID))?.state).toMatchObject({ attempts: [attempt({ at: expect.any(String) })] })
    expect(JSON.stringify(f.events)).not.toContain('Nothing was charged')
    await f.tap('paypal', undefined)
    expect(f.paypal.orders).toMatchObject([{ requestId: attempt().request_id, amount: '30.00', card: expect.any(Object) }, { requestId: attempt().request_id, amount: '30.00', card: expect.any(Object) }])
    expect(f.model.calls).toBe(1)
    expect(f.takeVisitorBuy).toHaveBeenCalledTimes(1)
    const saved = await f.conversations.get(ID)
    expect((saved?.state as State).purchases).toHaveLength(1)
    expect(saved?.state.attempts).toMatchObject([{ status: 'done', order_id: 'ORDER123' }])
    expect(saved?.turns.flat().filter(e => e.t === 'paid')).toHaveLength(1)
    expect(f.events).toContainEqual({ t: 'error', text: 'A payment for this gift is still being checked with PayPal.' })
  })

  it('keeps a returned card order with no capture and checks it on the next tap', async () => {
    const f = await setup()
    f.paypal.createOrder = async o => { f.paypal.orders.push(o); return { id: 'ORDER123', status: 'CREATED' } }
    f.paypal.getOrder = vi.fn(async () => ({ id: 'ORDER123', status: 'COMPLETED', captureId: 'CAPTURE1', captureStatus: 'COMPLETED', amount: '30.00', customId: `gs-${ID}-t1c1` }))
    await f.tap()
    expect((await f.conversations.get(ID))?.state).toMatchObject({ purchases: [{ order_id: 'ORDER123', status: 'created' }], attempts: [{ status: 'done', order_id: 'ORDER123' }] })
    expect(f.events).toContainEqual({ t: 'error', text: 'PayPal made the order but has not confirmed the payment yet. Tap Pay again to check.' })
    await f.tap()
    expect(f.paypal.getOrder).toHaveBeenCalledExactlyOnceWith('ORDER123')
    expect(f.paypal.orders).toHaveLength(1)
    expect((await f.conversations.get(ID))?.state).toMatchObject({ purchases: [{ status: 'captured' }] })
    expect((await f.conversations.get(ID))?.turns.flat().filter(e => e.t === 'paid')).toHaveLength(1)
  })

  it('keeps the order id from an incomplete create answer and reads it on retry', async () => {
    const f = await setup()
    const { fetcher } = fetcherFor({ '/v2/checkout/orders': () => Response.json({ id: 'ORDER123' }) })
    const client = new PayPal('id', 'secret', fetcher)
    f.paypal.createOrder = client.createOrder.bind(client)
    f.paypal.getOrder = vi.fn(async () => ({ id: 'ORDER123', status: 'COMPLETED', captureId: 'CAPTURE1', captureStatus: 'COMPLETED', amount: '30.00', customId: `gs-${ID}-t1c1` }))
    await f.tap()
    expect((await f.conversations.get(ID))?.state).toMatchObject({ attempts: [{ status: 'unknown', order_id: 'ORDER123' }], purchases: [{ order_id: 'ORDER123', status: 'created' }] })
    expect(JSON.stringify(f.events)).not.toContain('Nothing was charged')
    await f.tap()
    expect(f.paypal.getOrder).toHaveBeenCalledTimes(1)
    expect((await f.conversations.get(ID))?.turns.flat().filter(e => e.t === 'paid')).toHaveLength(1)
  })

  it('reads the approval link of a created order without a capture', async () => {
    const s = state(); s.attempts = [attempt({ method: 'paypal', order_id: 'ORDER123' })]
    const f = await setup(s)
    const { fetcher, sent } = fetcherFor({ '/v2/checkout/orders/ORDER123': () => Response.json({ id: 'ORDER123', status: 'CREATED', purchase_units: [{ custom_id: `gs-${ID}-t1c1`, amount: { value: '30.00' } }], links: [{ rel: 'approve', href: 'https://paypal.test/approve' }] }) })
    const client = new PayPal('id', 'secret', fetcher)
    f.paypal.getOrder = client.getOrder.bind(client)
    await f.tap('paypal')
    expect(sent.at(-1)?.method).toBe('GET')
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'order', order_id: 'ORDER123', approve_url: 'https://paypal.test/approve' }))
    expect((await f.conversations.get(ID))?.state).toMatchObject({ attempts: [{ status: 'done' }], purchases: [{ status: 'created' }] })
    expect(f.model.calls).toBe(0)
  })

  it.each(['unavailable', 'wrong card', 'wrong amount', 'pending capture'])('keeps a known order uncertain after a status check: %s', async answer => {
    const s = state(); s.attempts = [attempt({ order_id: 'ORDER123' })]
    const f = await setup(s)
    f.paypal.getOrder = vi.fn(async () => {
      if (answer === 'unavailable') throw new PayPalError('unavailable', 404)
      return { id: 'ORDER123', status: 'COMPLETED', captureId: 'CAPTURE1', captureStatus: answer === 'pending capture' ? 'PENDING' : 'COMPLETED', amount: answer === 'wrong amount' ? '31.00' : '30.00', customId: answer === 'wrong card' ? `gs-${ID}-t1c2` : `gs-${ID}-t1c1` }
    })
    await f.tap()
    expect(f.events.some(e => e.t === 'paid')).toBe(false)
    expect(JSON.stringify(f.events)).not.toContain('Nothing was charged')
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.model.calls).toBe(0)
    expect((await f.conversations.get(ID))?.state.attempts).toMatchObject([{ status: 'unknown', order_id: 'ORDER123' }])
  })

  it.each(['timeout', 'created', 'captured'])('keeps a webhook capture that arrives before create finishes with %s', async answer => {
    const f = await setup()
    f.paypal.verifyWebhook = async () => true
    f.paypal.createOrder = async o => {
      f.paypal.orders.push(o)
      expect((await deliver(f.conversations, f.paypal)).status).toBe(200)
      if (answer === 'timeout') throw new Error('timeout')
      return { id: 'ORDER123', status: answer === 'created' ? 'CREATED' : 'COMPLETED', ...(answer === 'captured' ? { captureId: 'CAPTURE1' } : {}) }
    }
    await f.tap()
    const saved = await f.conversations.get(ID)
    expect(saved?.state.attempts).toMatchObject([{ status: 'done', order_id: 'ORDER123' }])
    expect((saved?.state as State).purchases).toMatchObject([{ status: 'captured', capture_id: 'CAPTURE1' }])
    expect(saved?.turns.flat().filter(e => e.t === 'paid')).toHaveLength(1)
    await f.tap()
    expect(f.paypal.orders).toHaveLength(1)
  })

  it('takes one counter for overlapping taps that lose an answer', async () => {
    const f = await setup()
    f.paypal.createOrder = async o => {
      f.paypal.orders.push(o)
      if (f.paypal.orders.length === 1) throw new Error('timeout')
      return { id: 'ORDER123', status: 'COMPLETED', captureId: 'CAPTURE1' }
    }
    await Promise.all([f.tap(), f.tap('paypal')])
    expect(f.takeVisitorBuy).toHaveBeenCalledTimes(1)
    expect(f.model.calls).toBe(1)
    expect(f.paypal.orders.map(o => o.requestId)).toEqual([attempt().request_id, attempt().request_id])
    expect((await f.conversations.get(ID))?.turns.flat().filter(e => e.t === 'paid')).toHaveLength(1)
  })

  it('checks a done attempt if saving its purchase was interrupted', async () => {
    const s = state(); s.attempts = [attempt({ status: 'done', order_id: 'ORDER123' })]
    const f = await setup(s)
    f.paypal.getOrder = vi.fn(async () => ({ id: 'ORDER123', status: 'COMPLETED', captureId: 'CAPTURE1', captureStatus: 'COMPLETED', amount: '30.00', customId: `gs-${ID}-t1c1` }))
    await f.tap()
    expect(f.model.calls).toBe(0)
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
    expect((await f.conversations.get(ID))?.state).toMatchObject({ purchases: [{ order_id: 'ORDER123', status: 'captured' }] })
  })

  it('allows a new attempt after a saved order is confirmed refused', async () => {
    const s = state(); s.attempts = [attempt({ status: 'done', order_id: 'ORDER123' })]
    s.purchases = [{ card: 't1c1', gift: s.cards[0].gift, order_id: 'ORDER123', amount: '30.00', status: 'created' }]
    const f = await setup(s)
    f.paypal.getOrder = vi.fn(async () => ({ id: 'ORDER123', status: 'VOIDED', customId: `gs-${ID}-t1c1` }))
    await f.tap()
    expect((await f.conversations.get(ID))?.state.attempts).toMatchObject([{ status: 'failed' }])
    await f.tap()
    expect(f.paypal.orders).toMatchObject([{ requestId: `gs-${ID}-t1c1-a2` }])
  })

  it('stops a legacy unresolved product payment without refreshing a changed offer or replacing its amount', async () => {
    const s = state(); s.attempts = [attempt()]
    s.cards[0].product = { id: 'product-1', title: 'Fender strap', price: 35, url: 'https://shop.test/strap', source: 'channel3' }
    const f = await setup(s), product = vi.fn(async (): Promise<ProductResult> => ({ ok: false, reason: 'capped' }))
    Object.assign(f.deps, { products: { product } })
    await f.tap('paypal', undefined)
    expect(product).not.toHaveBeenCalled()
    expect(f.model.calls).toBe(0)
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.events).toContainEqual(expect.objectContaining({ t: 'error', text: expect.stringContaining('unresolved') }))
    expect(JSON.stringify(f.events)).not.toContain('Nothing was charged')
  })

  it('finishes a saved order with an unknown attempt when its webhook arrives', async () => {
    const s = state(); s.attempts = [attempt({ order_id: 'ORDER123' })]
    s.purchases = [{ card: 't1c1', gift: s.cards[0].gift, order_id: 'ORDER123', amount: '30.00', status: 'created' }]
    const f = await setup(s)
    f.paypal.verifyWebhook = async () => true
    await deliver(f.conversations, f.paypal)
    const saved = await f.conversations.get(ID)
    expect(saved?.state.attempts).toMatchObject([{ status: 'done' }])
    expect(saved?.turns.flat().filter(e => e.t === 'paid')).toHaveLength(1)
  })

  it.each(['unverified', 'wrong card', 'wrong amount', 'wrong order', 'pending capture', 'failed attempt'])('ignores a recovery webhook with %s', async answer => {
    const s = state(); s.attempts = [attempt(answer === 'wrong order' ? { order_id: 'OTHER123' } : answer === 'failed attempt' ? { status: 'failed' } : {})]
    const f = await setup(s)
    f.paypal.verifyWebhook = async () => answer !== 'unverified'
    const body = captureBody(answer === 'wrong card' ? { custom_id: `gs-${ID}-t1c2` } : answer === 'wrong amount' ? { amount: { value: '31.00' } } : answer === 'pending capture' ? { status: 'PENDING' } : {})
    const before = await f.conversations.get(ID)
    await deliver(f.conversations, f.paypal, body)
    expect(await f.conversations.get(ID)).toEqual(before)
    expect(f.paypal.captures).toHaveLength(0)
  })

  it.each(['sent', 'unknown'] as const)('reads a saved %s order and captures an approved order', async status => {
    const s = state(); s.attempts = [attempt({ status, order_id: 'ORDER123' })]
    const f = await setup(s)
    f.paypal.getOrder = vi.fn(async () => ({ id: 'ORDER123', status: 'APPROVED', customId: `gs-${ID}-t1c1`, amount: '30.00' }))
    await f.tap()
    expect(f.paypal.captures).toEqual(['ORDER123'])
    expect(f.paypal.orders).toHaveLength(0)
    expect(f.model.calls).toBe(0)
    expect(f.takeVisitorBuy).not.toHaveBeenCalled()
    expect((await f.conversations.get(ID))?.state).toMatchObject({ attempts: [{ status: 'done' }], purchases: [{ order_id: 'ORDER123', status: 'captured' }] })
  })

  it.each(['capture', 'approved'])('recovers a missing purchase from an unknown attempt through a %s webhook once', async kind => {
    const s = state(); s.attempts = [attempt()]
    const f = await setup(s)
    f.paypal.verifyWebhook = async () => true
    const body = kind === 'capture'
      ? { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE1', status: 'COMPLETED', custom_id: `gs-${ID}-t1c1`, amount: { value: '30.00' }, supplementary_data: { related_ids: { order_id: 'ORDER123' } } } }
      : { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER123', purchase_units: [{ custom_id: `gs-${ID}-t1c1`, amount: { value: '30.00' } }] } }
    for (let i = 0; i < 2; i++) expect((await handleWebhook(new Request(`${ORIGIN}/api/paypal/webhook`, { method: 'POST', body: JSON.stringify(body) }), { conversations: f.conversations, paypal: f.paypal, webhookId: 'wh' })).status).toBe(200)
    const saved = await f.conversations.get(ID)
    expect((saved?.state as State).purchases).toMatchObject([{ card: 't1c1', order_id: 'ORDER123', capture_id: 'CAPTURE1', amount: '30.00', status: 'captured' }])
    expect((saved?.state as State).purchases).toHaveLength(1)
    expect(saved?.state.attempts).toMatchObject([{ status: 'done', order_id: 'ORDER123' }])
    expect(saved?.turns.flat().filter(e => e.t === 'paid')).toHaveLength(1)
    expect(f.paypal.captures).toHaveLength(kind === 'capture' ? 0 : 1)
    const back = await paidReturn(new URL(`${ORIGIN}/paid?c=${ID}&token=ORDER123`), { conversations: f.conversations, paypal: f.paypal })
    expect(back.status).toBe(303)
    const refunded = await refundPurchase({ conversation: ID, card: 't1c1', owner: await ownerToken(ID, SECRET) }, { conversations: f.conversations, paypal: f.paypal, ownerSecret: SECRET })
    expect(refunded.event).toMatchObject({ t: 'refunded', order_id: 'ORDER123', capture_id: 'CAPTURE1' })
  })
})
