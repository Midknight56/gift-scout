import { afterEach, describe, expect, it } from 'vitest'
import { newState, type Budget, type ConversationState } from '../../src/agent/agent'
import { runBuyTurn } from '../../src/agent/buy'
import type { ScoutEvent } from '../../src/agent/events'
import type { ChatMessage, Model, ModelReply, ToolCall } from '../../src/agent/model'
import { buyTurn, ownerToken, paidReturn } from '../../src/app/buy'
import { PayPal, PayPalError } from '../../src/paypal/client'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const ID = 'conv1234'
const ORIGIN = 'https://gift.test'
const OWNER_SECRET = 'test-secret'
const dbs: FakeD1[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

function state(): ConversationState & { purchases?: import('../../src/agent/buy').Purchase[] } {
  return {
    ...newState(ID), turn: 1,
    cards: [{ id: 't1c1', gift: 'A Fender gift card', why: 'She likes music.', price_low: 20, price_high: 40,
      entity: { id: 'FENDER', name: 'Fender', type: 'brand' }, seeds: ['Phoebe Bridgers'], from_call: 1 }],
  }
}
function toolCall(cardId = 't1c1', amount = 30): ToolCall {
  return { id: 'buy1', type: 'function', function: { name: 'buy_gift', arguments: JSON.stringify({ card_id: cardId, amount_usd: amount }) } }
}
function reply(calls: ToolCall[]): ModelReply { return { content: '', tool_calls: calls, prompt_tokens: 20, completion_tokens: 5 } }
function scripted(replies: ModelReply[]): Model & { offered: string[][]; seen: ChatMessage[][] } {
  const offered: string[][] = [], seen: ChatMessage[][] = []
  return { name: 'scripted', offered, seen, async chat(messages, tools) {
    seen.push(structuredClone(messages)); offered.push(tools.map((t) => t.function.name))
    const next = replies.shift(); if (!next) throw new Error('unexpected model call'); return next
  } }
}
function budget(allowed = true): Budget { return { allow: async () => allowed, reserve: async () => allowed ? { settle: async () => {} } : null } }
function fakePayPal() {
  const orders: unknown[] = [], captures: string[] = []
  return {
    orders, captures,
    async createOrder(o: unknown) { orders.push(o); return { id: 'ORDER123', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://paypal.test/approve' } },
    async capture(id: string) { captures.push(id); return { orderId: id, status: 'COMPLETED', captureId: 'CAPTURE123', amount: '30.00', customId: `gs-${ID}-t1c1` } },
  } as unknown as PayPal & { orders: unknown[]; captures: string[] }
}
function makeDb() { const db = new FakeD1(); dbs.push(db); return { db, conversations: new Conversations(db) } }
async function savedConversation(conversations: Conversations, s = state(), turns: ScoutEvent[][] = []) {
  await conversations.put(ID, s, turns)
}

describe('PayPal client', () => {
  it('uses Basic client credentials and reuses a live token for a second order', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init! })
      if (String(input).endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'token', expires_in: 3600 })
      return Response.json({ id: 'ORDER123', status: 'CREATED', links: [] })
    }) as typeof fetch
    const paypal = new PayPal('id', 'secret', fetcher, 'https://api.test', () => 1000)
    const input = { amount: '30.00', customId: 'gs-x-t1c1', description: 'Gift', returnUrl: 'https://gift.test/paid', cancelUrl: 'https://gift.test/s/x', requestId: 'req1' }
    await paypal.createOrder(input); await paypal.createOrder({ ...input, requestId: 'req2' })
    const tokens = requests.filter((r) => r.url.endsWith('/v1/oauth2/token'))
    expect(tokens).toHaveLength(1)
    expect(tokens[0].init.method).toBe('POST')
    expect(tokens[0].init.headers).toMatchObject({ Authorization: `Basic ${btoa('id:secret')}` })
    expect(tokens[0].init.body).toBe('grant_type=client_credentials')
  })

  it('posts the order details and returns the payer-action link', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init! })
      return String(input).endsWith('/token') ? Response.json({ access_token: 'tok', expires_in: 3600 }) : Response.json({ id: 'ORDER123', status: 'CREATED', links: [{ rel: 'payer-action', href: 'https://paypal.test/pay' }] })
    }) as typeof fetch
    const p = new PayPal('id', 'secret', fetcher, 'https://api.test')
    const result = await p.createOrder({ amount: '30.00', customId: 'gs-c-t1c1', description: 'Gift', returnUrl: 'https://gift.test/paid?c=c', cancelUrl: 'https://gift.test/s/c', requestId: 'gs-c-t1c1-30.00' })
    const req = requests.find((r) => r.url.endsWith('/v2/checkout/orders'))!
    expect(req.init.method).toBe('POST')
    expect(req.init.headers).toMatchObject({ 'PayPal-Request-Id': 'gs-c-t1c1-30.00' })
    expect(JSON.parse(String(req.init.body))).toMatchObject({ intent: 'CAPTURE', purchase_units: [{ custom_id: 'gs-c-t1c1', amount: { currency_code: 'USD', value: '30.00' } }], payment_source: { paypal: { experience_context: { return_url: 'https://gift.test/paid?c=c', cancel_url: 'https://gift.test/s/c' } } } })
    expect(result.approveUrl).toBe('https://paypal.test/pay')
  })

  it('reads capture fields from the first purchase unit capture', async () => {
    const fetcher = (async (input: RequestInfo | URL) => String(input).endsWith('/token') ? Response.json({ access_token: 'tok', expires_in: 3600 }) : Response.json({ purchase_units: [{ custom_id: 'gs-c-t1c1', payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { value: '30.00' }, custom_id: 'gs-c-t1c1' }] } }] })) as typeof fetch
    await expect(new PayPal('id', 'secret', fetcher, 'https://api.test').capture('ORDER123')).resolves.toEqual({ orderId: 'ORDER123', status: 'COMPLETED', captureId: 'CAPTURE123', amount: '30.00', customId: 'gs-c-t1c1' })
  })

  it('turns PayPal errors into PayPalError with status and debug id', async () => {
    const fetcher = (async (input: RequestInfo | URL) => String(input).endsWith('/token') ? Response.json({ access_token: 'tok', expires_in: 3600 }) : Response.json({ name: 'UNPROCESSABLE_ENTITY', debug_id: 'DBG123' }, { status: 422 })) as typeof fetch
    try { await new PayPal('id', 'secret', fetcher, 'https://api.test').capture('ORDER123'); throw new Error('expected PayPalError') }
    catch (e) { expect(e).toBeInstanceOf(PayPalError); expect(e).toMatchObject({ status: 422, debugId: 'DBG123' }) }
  })
})

describe('runBuyTurn', () => {
  it('offers only buy_gift, refuses a different card, then creates the tapped card order', async () => {
    const model = scripted([reply([toolCall('t1c2')]), reply([toolCall()])]), paypal = fakePayPal(), events: ScoutEvent[] = []
    const next = await runBuyTurn({ cardId: 't1c1', state: state(), model, budget: budget(), paypal, origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(model.offered).toEqual([['buy_gift'], ['buy_gift']])
    expect(paypal.orders).toEqual([{ amount: '30.00', customId: `gs-${ID}-t1c1`, description: 'A Fender gift card', returnUrl: `${ORIGIN}/paid?c=${ID}`, cancelUrl: `${ORIGIN}/s/${ID}`, requestId: `gs-${ID}-t1c1-30.00-paypal` }])
    expect(events.map((e) => e.t)).toEqual(['call', 'result', 'call', 'result', 'order', 'usage'])
    expect(next.purchases).toMatchObject([{ card: 't1c1', order_id: 'ORDER123', amount: '30.00', status: 'created' }])
    expect(next.purchases?.[0].approve_url).toBe('https://paypal.test/approve')
  })

  it('reuses a waiting PayPal order and rejects a card buy without calling the model', async () => {
    const s = state()
    s.purchases = [{ card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', status: 'created', approve_url: 'https://paypal.test/approve' }]
    const paypal = fakePayPal(), events: ScoutEvent[] = []
    const model = scripted([])
    await runBuyTurn({ cardId: 't1c1', state: s, model, budget: budget(), paypal, origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(model.seen).toHaveLength(0)
    expect(paypal.orders).toHaveLength(0)
    expect(events).toEqual([{ t: 'order', card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', method: 'paypal', approve_url: 'https://paypal.test/approve' }])

    const cardEvents: ScoutEvent[] = [], cardModel = scripted([]), cardPaypal = fakePayPal()
    await runBuyTurn({ cardId: 't1c1', method: 'card', state: s, model: cardModel, budget: budget(), paypal: cardPaypal, origin: ORIGIN, emit: (e) => { cardEvents.push(e) } })
    expect(cardModel.seen).toHaveLength(0)
    expect(cardPaypal.orders).toHaveLength(0)
    expect(cardEvents).toEqual([{ t: 'error', text: 'This gift already has a PayPal order waiting. Approve it at PayPal first.' }])

    const noLink = state(), noLinkEvents: ScoutEvent[] = [], noLinkModel = scripted([]), noLinkPaypal = fakePayPal()
    noLink.purchases = [{ card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER124', amount: '30.00', status: 'created' }]
    await runBuyTurn({ cardId: 't1c1', state: noLink, model: noLinkModel, budget: budget(), paypal: noLinkPaypal, origin: ORIGIN, emit: (e) => { noLinkEvents.push(e) } })
    expect(noLinkModel.seen).toHaveLength(0)
    expect(noLinkPaypal.orders).toHaveLength(0)
    expect(noLinkEvents).toEqual([{ t: 'error', text: 'This gift already has a PayPal order waiting. Approve it at PayPal first.' }])
  })

  it('makes one order when two buys for the same card start at once', async () => {
    const s = state(), paypal = fakePayPal(), model = scripted([reply([toolCall()]), reply([toolCall()])])
    const events: ScoutEvent[][] = [[], []]
    await Promise.all(events.map((out) => runBuyTurn({ cardId: 't1c1', state: s, model, budget: budget(), paypal, origin: ORIGIN, emit: (e) => { out.push(e) } })))
    expect(paypal.orders).toHaveLength(1)
    expect(model.seen).toHaveLength(1)
    expect(events[1]).toContainEqual(expect.objectContaining({ t: 'order', order_id: 'ORDER123', approve_url: 'https://paypal.test/approve' }))
  })

  it('refuses an amount outside the card price band without making an order', async () => {
    const model = scripted([reply([toolCall('t1c1', 45)])]), paypal = fakePayPal(), events: ScoutEvent[] = []
    await runBuyTurn({ cardId: 't1c1', state: state(), model, budget: budget(), paypal, origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(paypal.orders).toHaveLength(0)
    expect(events.find((e) => e.t === 'result')).toMatchObject({ ok: false, text: expect.stringContaining('from 20 to 40') })
  })

  it('requires the exact product price and uses the product title for the PayPal order', async () => {
    const s = state()
    s.cards[0].product = { title: 'Fender woven strap', brand: 'Fender', price: 35, url: 'https://shop.test/strap', source: 'channel3' }
    const paypal = fakePayPal(), events: ScoutEvent[] = []
    const refused = scripted([reply([toolCall('t1c1', 34)])])
    await runBuyTurn({ cardId: 't1c1', state: s, model: refused, budget: budget(), paypal, origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(paypal.orders).toHaveLength(0)
    expect(events.find((e) => e.t === 'result')).toMatchObject({ ok: false, text: 'The amount must be exactly 35 for Fender woven strap.' })
    const acceptedEvents: ScoutEvent[] = []
    const accepted = scripted([reply([toolCall('t1c1', 35)])])
    const next = await runBuyTurn({ cardId: 't1c1', state: s, model: accepted, budget: budget(), paypal, origin: ORIGIN, emit: (e) => { acceptedEvents.push(e) } })
    expect(accepted.seen[0].at(-1)?.content).toContain('Fender woven strap, $35')
    expect(paypal.orders[0]).toMatchObject({ amount: '35.00', description: 'Fender woven strap' })
    expect(acceptedEvents.find((e) => e.t === 'order')).toMatchObject({ product_title: 'Fender woven strap', product_url: 'https://shop.test/strap' })
    expect(next.purchases?.[0]).toMatchObject({ product_title: 'Fender woven strap', product_url: 'https://shop.test/strap' })
  })

  it('accepts a product priced below the card band at its exact price', async () => {
    const s = state()
    s.cards[0].product = { title: 'Fender pick tin', brand: 'Fender', price: 12, url: 'https://shop.test/picks', source: 'channel3' }
    const paypal = fakePayPal(), events: ScoutEvent[] = []
    await runBuyTurn({ cardId: 't1c1', state: s, model: scripted([reply([toolCall('t1c1', 12)])]), budget: budget(), paypal, origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(paypal.orders[0]).toMatchObject({ amount: '12.00', description: 'Fender pick tin' })
  })

  it('emits an error without calling the model for a card absent from state', async () => {
    const model = scripted([]), events: ScoutEvent[] = []
    await runBuyTurn({ cardId: 'missing', state: state(), model, budget: budget(), paypal: fakePayPal(), origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(model.seen).toHaveLength(0); expect(events[0]?.t).toBe('error')
  })

  it('emits an error without calling the model when budget is spent', async () => {
    const model = scripted([]), events: ScoutEvent[] = []
    await runBuyTurn({ cardId: 't1c1', state: state(), model, budget: budget(false), paypal: fakePayPal(), origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(model.seen).toHaveLength(0); expect(events[0]?.t).toBe('error')
  })
})

describe('buy and paid routes', () => {
  it('reports buying off and makes no order when PayPal is absent', async () => {
    const { conversations } = makeDb(); await savedConversation(conversations)
    const events: ScoutEvent[] = [], paypal = fakePayPal()
    await buyTurn(ID, 't1c1', { conversations, paypal: null, live: null, origin: ORIGIN, ownerSecret: OWNER_SECRET }, async (e) => { events.push(e) }, 'paypal', await ownerToken(ID, OWNER_SECRET))
    expect(events).toMatchObject([{ t: 'run', mode: 'off', purpose: 'buy' }, { t: 'error' }]); expect(paypal.orders).toHaveLength(0)
  })

  it('saves a buy turn as a new conversation turn with buy purpose', async () => {
    const { conversations } = makeDb(); await savedConversation(conversations, state(), [[{ t: 'say', text: 'prior' }]])
    const model = scripted([reply([toolCall()])]), paypal = fakePayPal(), events: ScoutEvent[] = []
    await buyTurn(ID, 't1c1', { conversations, paypal, live: { model, budget: budget(), takeVisitorBuy: async () => true }, origin: ORIGIN, ownerSecret: OWNER_SECRET }, async (e) => { events.push(e) }, 'paypal', await ownerToken(ID, OWNER_SECRET))
    const saved = await conversations.get(ID)
    expect(saved?.turns).toHaveLength(2)
    expect(saved?.turns[1][0]).toMatchObject({ t: 'run', purpose: 'buy' })
    expect(saved?.state).toMatchObject({ purchases: [{ order_id: 'ORDER123', status: 'created' }] })
  })

  it('captures an order once, appends paid to its turn, then redirects to the conversation', async () => {
    const { conversations } = makeDb(), s = state()
    s.purchases = [{ card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', status: 'created' }]
    await savedConversation(conversations, s, [[{ t: 'run', conversation: ID, turn: 1, mode: 'live', purpose: 'buy' }, { t: 'order', card: 't1c1', gift: 'A Fender gift card', order_id: 'ORDER123', amount: '30.00', approve_url: 'https://paypal.test/pay' }]])
    const paypal = fakePayPal(), url = new URL(`https://gift.test/paid?c=${ID}&token=ORDER123`)
    const first = await paidReturn(url, { conversations, paypal, now: () => 1000 })
    expect(first.status).toBe(303); expect(first.headers.get('Location')).toBe(`https://gift.test/s/${ID}`)
    let saved = await conversations.get(ID)
    expect(saved?.state).toMatchObject({ purchases: [{ status: 'captured', capture_id: 'CAPTURE123' }] })
    expect(saved?.turns[0].at(-1)).toMatchObject({ t: 'paid', order_id: 'ORDER123' })
    const second = await paidReturn(url, { conversations, paypal })
    expect(second.status).toBe(303); expect(paypal.captures).toEqual(['ORDER123'])
  })

  it('returns 404 without capture for an order the conversation did not make', async () => {
    const { conversations } = makeDb(); await savedConversation(conversations)
    const paypal = fakePayPal(), response = await paidReturn(new URL(`https://gift.test/paid?c=${ID}&token=ORDER123`), { conversations, paypal })
    expect(response.status).toBe(404); expect(paypal.captures).toHaveLength(0)
  })

  it('returns 400 and saves nothing when the capture custom id is not for this conversation', async () => {
    const { conversations } = makeDb(), s = state()
    s.purchases = [{ card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00', status: 'created' }]
    await savedConversation(conversations, s, [[{ t: 'order', card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00', approve_url: 'https://paypal.test/pay' }]])
    const before = await conversations.get(ID), paypal = fakePayPal()
    paypal.capture = (async (id: string) => { paypal.captures.push(id); return { orderId: id, status: 'COMPLETED', captureId: 'CAPTURE123', amount: '30.00', customId: 'gs-other-t1c1' } }) as typeof paypal.capture
    const response = await paidReturn(new URL(`https://gift.test/paid?c=${ID}&token=ORDER123`), { conversations, paypal })
    expect(response.status).toBe(400); expect(paypal.captures).toEqual(['ORDER123']); expect(await conversations.get(ID)).toEqual(before)
  })

  it('returns 409 when PayPal says capture is not approved', async () => {
    const { conversations } = makeDb(), s = state()
    s.purchases = [{ card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00', status: 'created' }]
    await savedConversation(conversations, s)
    const paypal = fakePayPal()
    paypal.capture = (async () => { throw new PayPalError('not approved', 422) }) as typeof paypal.capture
    const response = await paidReturn(new URL(`https://gift.test/paid?c=${ID}&token=ORDER123`), { conversations, paypal, retryMs: 0 })
    expect(response.status).toBe(409)
  })

  it('shows the conversation when the webhook captured the order a moment before the buyer came back', async () => {
    const { conversations } = makeDb(), s = state()
    s.purchases = [{ card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00', status: 'created' }]
    await savedConversation(conversations, s)
    const paypal = fakePayPal()
    paypal.capture = (async () => {
      const done = state(); done.purchases = [{ card: 't1c1', gift: 'Gift', order_id: 'ORDER123', amount: '30.00', status: 'captured', capture_id: 'C9' }]
      await conversations.put(ID, done, [])
      throw new PayPalError('ORDER_ALREADY_CAPTURED', 422)
    }) as typeof paypal.capture
    const response = await paidReturn(new URL(`https://gift.test/paid?c=${ID}&token=ORDER123`), { conversations, paypal, retryMs: 0 })
    expect(response.status).toBe(303)
  })
})

describe("paying with PayPal's test card", () => {
  it('pays the tapped card at once, shows order and paid, and marks the purchase captured', async () => {
    const orders: { card?: { number: string } }[] = []
    const paypal = {
      async createOrder(o: { card?: { number: string } }) { orders.push(o); return { id: 'ORDERCARD1', status: 'COMPLETED', captureId: 'CAPTURECARD1' } },
    } as unknown as PayPal
    const events: ScoutEvent[] = []
    const next = await runBuyTurn({ cardId: 't1c1', method: 'card', state: state(), model: scripted([reply([toolCall()])]), budget: budget(), paypal, origin: ORIGIN, now: () => 0, emit: (e) => { events.push(e) } })
    expect(orders[0].card?.number).toBe('4111111111111111')
    expect(events.map((e) => e.t)).toEqual(['call', 'result', 'order', 'paid', 'usage'])
    expect(events.find((e) => e.t === 'order')).toMatchObject({ method: 'card', order_id: 'ORDERCARD1' })
    expect(next.purchases).toMatchObject([{ status: 'captured', capture_id: 'CAPTURECARD1', at: '1970-01-01T00:00:00.000Z' }])
  })

  it('makes no paid event when PayPal does not complete the card order', async () => {
    const paypal = { async createOrder() { return { id: 'ORDERCARD2', status: 'PAYER_ACTION_REQUIRED' } } } as unknown as PayPal
    const events: ScoutEvent[] = []
    await runBuyTurn({ cardId: 't1c1', method: 'card', state: state(), model: scripted([reply([toolCall()])]), budget: budget(), paypal, origin: ORIGIN, emit: (e) => { events.push(e) } })
    expect(events.some((e) => e.t === 'paid')).toBe(false)
    expect(events.some((e) => e.t === 'error')).toBe(true)
  })

  it('sends payment_source.card to PayPal and reads the capture from the create answer', async () => {
    const sent: { url: string; body: string }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: String(init?.body ?? '') })
      if (String(input).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
      return new Response(JSON.stringify({ id: 'O1', status: 'COMPLETED', links: [], purchase_units: [{ payments: { captures: [{ id: 'C1', status: 'COMPLETED' }] } }] }), { status: 201 })
    }) as typeof fetch
    const { SANDBOX_TEST_CARD } = await import('../../src/paypal/client')
    const order = await new PayPal('id', 'secret', fetcher).createOrder({ amount: '20.00', customId: 'gs-x-t1c1', description: 'd', returnUrl: 'r', cancelUrl: 'c', requestId: 'q', card: SANDBOX_TEST_CARD })
    const body = JSON.parse(sent[1].body) as { payment_source: Record<string, unknown> }
    expect(Object.keys(body.payment_source)).toEqual(['card'])
    expect(order).toMatchObject({ id: 'O1', status: 'COMPLETED', captureId: 'C1' })
  })
})
