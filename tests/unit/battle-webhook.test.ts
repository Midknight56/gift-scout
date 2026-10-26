import { afterEach, describe, expect, it } from 'vitest'
import { newState } from '../../src/agent/agent'
import type { ScoutEvent } from '../../src/agent/events'
import { handleWebhook, paidReturn } from '../../src/app/buy'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const ID = 'ab-cd_ef12'
const OTHER = 'other_123'
const ORDER = 'ORDER123'
const custom = `gs-${ID}-t1c3`
const headers = () => new Headers({
  'PAYPAL-AUTH-ALGO': 'SHA256withRSA', 'PAYPAL-CERT-URL': 'https://paypal.test/cert',
  'PAYPAL-TRANSMISSION-ID': 'tx', 'PAYPAL-TRANSMISSION-SIG': 'sig', 'PAYPAL-TRANSMISSION-TIME': '2026-10-23T12:00:00Z',
})
const dbs: FakeD1[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

function makeDb() {
  const db = new FakeD1(); dbs.push(db)
  return new Conversations(db)
}
function makeState(id = ID) {
  const s = newState(id)
  s.cards = [{ id: 't1c3', gift: 'A Fender gift card', why: 'Music', price_low: 20, price_high: 40,
    entity: { id: 'F', name: 'Fender', type: 'brand' }, seeds: [], from_call: 1 }]
  return s as typeof s & { purchases?: { card: string; gift: string; order_id: string; amount: string; status: 'created' | 'captured'; capture_id?: string }[] }
}
async function savePurchase(conversations: Conversations, id = ID, orderId = ORDER) {
  const s = makeState(id)
  s.purchases = [{ card: 't1c3', gift: 'A Fender gift card', order_id: orderId, amount: '30.00', status: 'created' }]
  const turns: ScoutEvent[][] = [[{ t: 'order', card: 't1c3', gift: 'A Fender gift card', order_id: orderId, amount: '30.00', method: 'paypal' }]]
  await conversations.put(id, s, turns)
}
function approved(id = custom, orderId = ORDER) {
  return JSON.stringify({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId, purchase_units: [{ custom_id: id }] } })
}
function completed(id = custom, orderId = ORDER, amount = '30.00') {
  return JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE123', custom_id: id, amount: { value: amount }, supplementary_data: { related_ids: { order_id: orderId } } } })
}
function request(body: string) { return new Request('https://gift.test/api/paypal/webhook', { method: 'POST', headers: headers(), body }) }
function fakePaypal(overrides: Record<string, unknown> = {}) {
  const captures: string[] = []
  return { captures, async verifyWebhook() { return true }, async capture(orderId: string) {
    captures.push(orderId); return { orderId, status: 'COMPLETED', captureId: 'CAPTURE123', amount: '30.00', customId: custom }
  }, ...overrides } as any
}
async function webhook(conversations: Conversations, paypal: any, raw: string) {
  return handleWebhook(request(raw), { conversations, paypal, webhookId: 'wh', now: () => 1000 })
}
async function paidCount(conversations: Conversations, id = ID) {
  const saved = await conversations.get(id)
  return saved?.turns.flat().filter((e) => e.t === 'paid' && e.order_id === ORDER).length ?? 0
}

describe('B3 webhook and return-page battle tests', () => {
  it('1. repeated genuine capture delivery records one paid event', async () => {
    const conversations = makeDb(); await savePurchase(conversations)
    const paypal = fakePaypal()
    expect((await webhook(conversations, paypal, completed())).status).toBe(200)
    expect((await webhook(conversations, paypal, completed())).status).toBe(200)
    expect(await paidCount(conversations)).toBe(1)
  })

  it('2. simultaneous approved deliveries capture at most once and add no duplicate paid row', async () => {
    const conversations = makeDb(); await savePurchase(conversations)
    let started = 0, release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const paypal = fakePaypal({ async capture(orderId: string) {
      paypal.captures.push(orderId); started++
      if (started === 1) release()
      await gate
      return { orderId, status: 'COMPLETED', captureId: 'CAPTURE123', amount: '30.00', customId: custom }
    } })
    const responses = await Promise.all([webhook(conversations, paypal, approved()), webhook(conversations, paypal, approved())])
    expect(responses.every((r: Response) => r.status === 200)).toBe(true)
    expect(paypal.captures.length).toBeLessThanOrEqual(1)
    expect(await paidCount(conversations)).toBe(1)
  })

  it('3. old approved event after /paid captured the order returns 200 without changing state', async () => {
    const conversations = makeDb(); await savePurchase(conversations)
    const capper = fakePaypal()
    await paidReturn(new URL(`https://gift.test/paid?c=${ID}&token=${ORDER}`), { conversations, paypal: capper, now: () => 1000 })
    const before = await conversations.get(ID)
    const response = await webhook(conversations, fakePaypal(), approved())
    expect(response.status).toBe(200); expect(await conversations.get(ID)).toEqual(before)
  })

  it('4a. invalid signature makes no change and is not acknowledged', async () => {
    const conversations = makeDb(); await savePurchase(conversations); const before = await conversations.get(ID)
    const response = await webhook(conversations, fakePaypal({ async verifyWebhook() { return false } }), approved())
    expect(response.status).not.toBe(200); expect(await conversations.get(ID)).toEqual(before)
  })

  it('4b. verifier exception makes no change and is not acknowledged as success', async () => {
    const conversations = makeDb(); await savePurchase(conversations); const before = await conversations.get(ID)
    let response: Response | undefined
    try { response = await webhook(conversations, fakePaypal({ async verifyWebhook() { throw new Error('verification unavailable') } }), approved()) } catch { /* a thrown handler is not a retryable HTTP response */ }
    expect(response?.status).toBeDefined()
    expect(response?.status).not.toBe(200)
    expect(await conversations.get(ID)).toEqual(before)
  })

  it('5. malformed custom ids, absent conversations and invalid conversation ids are ignored safely', async () => {
    const conversations = makeDb(); await savePurchase(conversations); const before = await conversations.get(ID)
    const paypal = fakePaypal()
    const ids = ['other-app', 'gs-missing_1-t1c3', 'gs-bad!id-t1c3']
    for (const id of ids) expect((await webhook(conversations, paypal, approved(id))).status).toBe(200)
    expect(await conversations.get(ID)).toEqual(before)
    expect(paypal.captures).toEqual([])
  })

  it('5b. card id in custom_id must belong to the conversation', async () => {
    const conversations = makeDb(); await savePurchase(conversations); const before = await conversations.get(ID)
    const response = await webhook(conversations, fakePaypal(), completed(`gs-${ID}-t1c9`))
    expect(response.status).toBe(200); expect(await conversations.get(ID)).toEqual(before)
  })

  it('6. completed capture arriving before approved event yields one paid row', async () => {
    const conversations = makeDb(); await savePurchase(conversations); const paypal = fakePaypal()
    await webhook(conversations, paypal, completed())
    await webhook(conversations, paypal, approved())
    expect(await paidCount(conversations)).toBe(1); expect(paypal.captures).toEqual([])
  })

  it('7. paid token from another conversation cannot mark either conversation paid', async () => {
    const conversations = makeDb(); await savePurchase(conversations, OTHER)
    const beforeOther = await conversations.get(OTHER)
    const paypal = fakePaypal()
    const response = await paidReturn(new URL(`https://gift.test/paid?c=${ID}&token=${ORDER}`), { conversations, paypal })
    expect(response.status).toBe(404); expect(paypal.captures).toEqual([])
    expect(await conversations.get(ID)).toBeNull(); expect(await conversations.get(OTHER)).toEqual(beforeOther)
  })

  it('8. /paid called twice adds one paid event', async () => {
    const conversations = makeDb(); await savePurchase(conversations); const paypal = fakePaypal()
    const url = new URL(`https://gift.test/paid?c=${ID}&token=${ORDER}`)
    await paidReturn(url, { conversations, paypal, now: () => 1000 })
    const before = await conversations.get(ID)
    await paidReturn(url, { conversations, paypal, now: () => 2000 })
    expect(paypal.captures).toEqual([ORDER]); expect(await paidCount(conversations)).toBe(1)
    expect(await conversations.get(ID)).toEqual(before)
  })

  it('9. mismatched capture amount is not treated as matching the saved order amount', async () => {
    const conversations = makeDb(); await savePurchase(conversations)
    const paypal = fakePaypal({ async capture(orderId: string) {
      paypal.captures.push(orderId); return { orderId, status: 'COMPLETED', captureId: 'CAPTURE123', amount: '31.00', customId: custom }
    } })
    await webhook(conversations, paypal, approved())
    expect((await conversations.get(ID))?.state).toMatchObject({ purchases: [{ status: 'created' }] })
    expect(await paidCount(conversations)).toBe(0)
  })

  it('10a. webhook body over 100 KB is not accepted as success', async () => {
    const conversations = makeDb(); await savePurchase(conversations); const before = await conversations.get(ID)
    const oversized = JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE123', custom_id: custom, amount: { value: '30.00' }, supplementary_data: { related_ids: { order_id: ORDER } }, padding: 'x'.repeat(101 * 1024) } })
    const response = await webhook(conversations, fakePaypal(), oversized)
    expect(response.status).not.toBe(200); expect(await conversations.get(ID)).toEqual(before)
  })

  it('10b. non-JSON webhook body is not acknowledged as success', async () => {
    const conversations = makeDb(); await savePurchase(conversations); const before = await conversations.get(ID)
    const response = await webhook(conversations, fakePaypal(), 'not JSON')
    expect(response.status).not.toBe(200); expect(await conversations.get(ID)).toEqual(before)
  })
})
