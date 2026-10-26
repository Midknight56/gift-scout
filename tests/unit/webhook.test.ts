import { afterEach, describe, expect, it } from 'vitest'
import { newState } from '../../src/agent/agent'
import type { ScoutEvent } from '../../src/agent/events'
import { handleWebhook } from '../../src/app/buy'
import { PayPal } from '../../src/paypal/client'
import { parseEvent } from '../../src/paypal/webhook'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const ID = 'ab-cd_ef12'
const headers = () => new Headers({
  'PAYPAL-AUTH-ALGO': 'SHA256withRSA', 'PAYPAL-CERT-URL': 'https://paypal.test/cert',
  'PAYPAL-TRANSMISSION-ID': 'tx1', 'PAYPAL-TRANSMISSION-SIG': 'sig', 'PAYPAL-TRANSMISSION-TIME': '2026-10-23T12:00:00Z',
})
const dbs: FakeD1[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
function makeDb() { const db = new FakeD1(); dbs.push(db); return { conversations: new Conversations(db) } }
function state() {
  const s = newState(ID)
  s.cards = [{ id: 't1c3', gift: 'A Fender gift card', why: 'Music', price_low: 20, price_high: 40, entity: { id: 'F', name: 'Fender', type: 'brand' }, seeds: [], from_call: 1 }]
  return s
}
const rawOrder = (customId = `gs-${ID}-t1c3`) => ` { "id":"ORDER123", "event_type":"CHECKOUT.ORDER.APPROVED", "resource": {"id":"ORDER123", "purchase_units":[{"custom_id":"${customId}"}]}} `
function fakePaypal(verify = true) {
  const captures: string[] = []
  return { captures, async verifyWebhook() { return verify }, async capture(orderId: string) { captures.push(orderId); return { orderId, status: 'COMPLETED', captureId: 'CAPTURE123', amount: '30.00', customId: `gs-${ID}-t1c3` } } } as any
}
async function makePurchase(conversations: Conversations, orderId = 'ORDER123', conversationId = ID) {
  const s = state() as ReturnType<typeof state> & { purchases?: { card: string; gift: string; order_id: string; amount: string; status: 'created' | 'captured' }[] }
  s.purchases = [{ card: 't1c3', gift: 'A Fender gift card', order_id: orderId, amount: '30.00', status: 'created' }]
  const turns: ScoutEvent[][] = [[{ t: 'order', card: 't1c3', gift: 'A Fender gift card', order_id: orderId, amount: '30.00', method: 'paypal' }]]
  await conversations.put(conversationId, s, turns)
}

describe('PayPal webhook verification', () => {
  it('sends all verification fields and the raw event unchanged; only SUCCESS verifies', async () => {
    const raw = rawOrder(), calls: { url: string; body: string }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body) })
      if (String(input).endsWith('/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 })
      return Response.json({ verification_status: 'SUCCESS' })
    }) as typeof fetch
    const p = new PayPal('id', 'secret', fetcher, 'https://api.test')
    expect(await p.verifyWebhook(headers(), raw, 'webhook-1')).toBe(true)
    const body = calls.find((x) => x.url.endsWith('/verify-webhook-signature'))!.body
    expect(body).toContain(raw)
    expect(JSON.parse(body)).toMatchObject({ auth_algo: 'SHA256withRSA', cert_url: 'https://paypal.test/cert', transmission_id: 'tx1', transmission_sig: 'sig', transmission_time: '2026-10-23T12:00:00Z', webhook_id: 'webhook-1' })
    const refused = new PayPal('id', 'secret', (async () => Response.json({ verification_status: 'NOPE' })) as typeof fetch, 'https://api.test')
    expect(await refused.verifyWebhook(headers(), raw, 'webhook-1')).toBe(false)
  })
  it('returns false without a PayPal call when a header is missing', async () => {
    let calls = 0
    const p = new PayPal('id', 'secret', (async () => { calls++; return Response.json({}) }) as typeof fetch, 'https://api.test')
    const h = headers(); h.delete('PAYPAL-CERT-URL')
    expect(await p.verifyWebhook(h, rawOrder(), 'wh')).toBe(false); expect(calls).toBe(0)
  })
})

describe('webhook events', () => {
  it('parses supported event shapes and rejects invalid or unrelated input', () => {
    expect(parseEvent(rawOrder())).toMatchObject({ type: 'CHECKOUT.ORDER.APPROVED', orderId: 'ORDER123', customId: `gs-${ID}-t1c3` })
    expect(parseEvent(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP1', custom_id: `gs-${ID}-t1c3`, amount: { value: '30.00' }, supplementary_data: { related_ids: { order_id: 'ORDER123' } } } }))).toMatchObject({ captureId: 'CAP1', orderId: 'ORDER123', amount: '30.00' })
    expect(parseEvent('{')).toBeNull(); expect(parseEvent('{"event_type":"OTHER"}')).toBeNull()
  })
  it('refuses unverified requests without changing the conversation', async () => {
    const { conversations } = makeDb(); await makePurchase(conversations)
    const before = await conversations.get(ID), response = await handleWebhook(new Request('https://gift.test/api/paypal/webhook', { method: 'POST', headers: headers(), body: rawOrder() }), { conversations, paypal: fakePaypal(false), webhookId: 'wh' })
    expect(response.status).toBe(401); expect(await conversations.get(ID)).toEqual(before)
  })
  it('captures an approved created order once and appends paid', async () => {
    const { conversations } = makeDb(); await makePurchase(conversations)
    const paypal = fakePaypal(), request = () => new Request('https://gift.test/api/paypal/webhook', { method: 'POST', headers: headers(), body: rawOrder() })
    expect((await handleWebhook(request(), { conversations, paypal, webhookId: 'wh', now: () => 1000 })).status).toBe(200)
    expect((await handleWebhook(request(), { conversations, paypal, webhookId: 'wh' })).status).toBe(200)
    const saved = await conversations.get(ID)
    expect(paypal.captures).toEqual(['ORDER123']); expect(saved?.state).toMatchObject({ purchases: [{ status: 'captured', capture_id: 'CAPTURE123' }] })
    expect(saved?.turns[0].at(-1)).toMatchObject({ t: 'paid', order_id: 'ORDER123', capture_id: 'CAPTURE123' })
  })
  it('records a completed capture from the event without calling capture', async () => {
    const { conversations } = makeDb(); await makePurchase(conversations); const paypal = fakePaypal()
    const raw = JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE_FROM_EVENT', custom_id: `gs-${ID}-t1c3`, amount: { value: '30.00' }, supplementary_data: { related_ids: { order_id: 'ORDER123' } } } })
    await handleWebhook(new Request('https://gift.test/api/paypal/webhook', { method: 'POST', headers: headers(), body: raw }), { conversations, paypal, webhookId: 'wh' })
    expect(paypal.captures).toEqual([]); expect((await conversations.get(ID))?.state).toMatchObject({ purchases: [{ status: 'captured', capture_id: 'CAPTURE_FROM_EVENT' }] })
  })
  it('ignores a completed capture whose amount differs from the saved order without calling capture', async () => {
    const { conversations } = makeDb(); await makePurchase(conversations); const paypal = fakePaypal()
    const raw = JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE_FROM_EVENT', custom_id: `gs-${ID}-t1c3`, amount: { value: '31.00' }, supplementary_data: { related_ids: { order_id: 'ORDER123' } } } })
    await handleWebhook(new Request('https://gift.test/api/paypal/webhook', { method: 'POST', headers: headers(), body: raw }), { conversations, paypal, webhookId: 'wh' })
    expect(paypal.captures).toEqual([]); expect((await conversations.get(ID))?.state).toMatchObject({ purchases: [{ status: 'created' }] })
  })
  it('ignores other app ids and unknown orders, and handles dashed conversation ids', async () => {
    const { conversations } = makeDb(); await makePurchase(conversations); const paypal = fakePaypal()
    for (const raw of [rawOrder('rt-someapp-t1c3'), rawOrder(`gs-${ID}-t1c3`).replaceAll('ORDER123', 'UNKNOWN1')]) {
      const response = await handleWebhook(new Request('https://gift.test/api/paypal/webhook', { method: 'POST', headers: headers(), body: raw }), { conversations, paypal, webhookId: 'wh' })
      expect(response.status).toBe(200); expect(await response.text()).toContain('ignored')
    }
    const response = await handleWebhook(new Request('https://gift.test/api/paypal/webhook', { method: 'POST', headers: headers(), body: rawOrder() }), { conversations, paypal, webhookId: 'wh' })
    expect(response.status).toBe(200); expect(paypal.captures).toEqual(['ORDER123'])
  })
})
