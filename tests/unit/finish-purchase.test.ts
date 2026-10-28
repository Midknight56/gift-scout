// The finished purchase: where the gift goes, a tracker after the capture, and a one tap refund.
import { afterEach, describe, expect, it } from 'vitest'
import { newState, type Budget, type ConversationState } from '../../src/agent/agent'
import { runBuyTurn, type Purchase } from '../../src/agent/buy'
import type { ScoutEvent } from '../../src/agent/events'
import type { Model, ModelReply, ToolCall } from '../../src/agent/model'
import { ownerToken, paidReturn, parseBuy, refundPurchase } from '../../src/app/buy'
import { PayPal, PayPalError } from '../../src/paypal/client'
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
  const sent: { url: string; body: string; requestId: string | null }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    sent.push({ url, body: String(init?.body ?? ''), requestId: new Headers(init?.headers).get('PayPal-Request-Id') })
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
  async function paidConversation() {
    const conversations = makeDb(), s = state()
    s.purchases = [{ card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', status: 'captured', capture_id: 'CAPTURE1', at: 'x' }]
    await conversations.put(ID, s, [[{ t: 'say', text: 'cards' }], [{ t: 'run', conversation: ID, turn: 1, mode: 'live', purpose: 'buy' }, { t: 'paid', card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', capture_id: 'CAPTURE1', amount: '30.00', at: 'x' }]])
    return conversations
  }

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
