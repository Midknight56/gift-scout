import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { newState } from '../../src/agent/agent'
import type { ScoutEvent } from '../../src/agent/events'
import { buyTurn, ownerToken, paidReturn } from '../../src/app/buy'
import { PayPal } from '../../src/paypal/client'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const recoveryStart = source.indexOf('function drawPaymentRecovery(')
const recovery = recoveryStart < 0 ? '' : source.slice(recoveryStart, source.indexOf('async function loadShare('))
const load = source.slice(source.indexOf('async function loadShare('), source.indexOf('async function loadFixture('))
const buy = source.slice(source.indexOf('async function buyCard('), source.indexOf('/** "Changed my mind"'))
const dbs: FakeD1[] = []
afterEach(() => { dbs.splice(0).forEach(db => db.close()) })

class Element {
  children: Element[] = []
  dataset: Record<string, string> = {}
  className = ''; textContent = ''; disabled = false
  append(child: Element) { this.children.push(child) }
  querySelectorAll() { return [] }
  setAttribute() {}
  removeAttribute() {}
}

function page(turns: ScoutEvent[][], owner: string | null, post = async (_body: Record<string, unknown>) => [] as ScoutEvent[]) {
  const chat = new Element(), cards = new Map(), redirects: string[] = [], errors: string[] = []
  const context = {
    chat, cards, conversation: null as string | null, busy: false, canBuy: true, leavingForPayPal: false,
    empty: { hidden: false }, examples: { hidden: false }, composer: { hidden: false },
    document: { createElement: () => new Element() }, ownerFor: () => owner,
    readShipping: () => ({}), quoteFor: () => 30, payCopy: () => ({ paypal: 'Pay at PayPal' }),
    addLine: (kind: string, text: string) => { if (kind === 'error-line') errors.push(text) },
    handleEvent: (event: ScoutEvent, opts?: { live: boolean }) => {
      if (event.t === 'run') context.conversation = event.conversation
      if (event.t === 'cards') { cards.clear(); event.cards.forEach(card => cards.set(card.id, card)) }
      if (event.t === 'order' && opts?.live !== false && event.approve_url) redirects.push(event.approve_url)
    },
    fetch: async (_url: string, init?: { body: string }) => init
      ? { ok: true, body: await post(JSON.parse(init.body)) }
      : { ok: true, json: async () => ({ turns }) },
    readEvents: async (response: { body: ScoutEvent[] }) => { response.body.forEach(event => context.handleEvent(event)) },
  }
  runInNewContext(`${buy}\n${recovery}\n${load}\nthis.load = loadShare; this.resume = button => buyCard(button.dataset.resume, button.dataset.method, null, button);`, context)
  return { chat, redirects, errors, context: context as typeof context & { load: (id: string) => Promise<void>; resume: (b: Element) => Promise<void> } }
}

it('shows owner recovery after cancellation and approves the original order without creating another', async () => {
  const db = new FakeD1(); dbs.push(db)
  const conversations = new Conversations(db), id = 'return123'
  const card = { id: 't1c1', gift: 'A Fender gift card', why: 'Music', price_low: 20, price_high: 40,
    entity: { id: 'brand', name: 'Fender', type: 'brand' }, seeds: [], from_call: 1 }
  await conversations.put(id, { ...newState(id), turn: 1, cards: [card] }, [[
    { t: 'run', conversation: id, turn: 1, mode: 'live', said: 'A gift' }, { t: 'cards', cards: [card], dropped: [] },
  ]])
  const createOrder = vi.fn(async (_request: { cancelUrl: string }) => ({ id: 'ORDER123', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://paypal.test/approve/ORDER123' }))
  const capture = vi.fn(async () => ({ orderId: 'ORDER123', captureId: 'CAP1', status: 'COMPLETED', amount: '30.00', customId: `gs-${id}-t1c1` }))
  const paypal = Object.assign(new PayPal('test', 'test', fetch), { createOrder, capture, addTracking: vi.fn(async () => ({})) })
  const model = { name: 'test', chat: vi.fn(async () => ({ content: '', prompt_tokens: 0, completion_tokens: 0,
    tool_calls: [{ id: 'buy', type: 'function' as const, function: { name: 'buy_gift', arguments: '{"card_id":"t1c1","amount_usd":30}' } }] })) }
  const deps = { conversations, paypal, ownerSecret: 'test', origin: 'https://gift.test',
    live: { model, takeVisitorBuy: async () => true, budget: { allow: async () => true, reserve: async () => ({ settle: async () => {} }) } } }
  const owner = await ownerToken(id, 'test')
  await buyTurn(id, card.id, deps, async () => {}, 'paypal', owner, undefined, undefined, 30)
  const cancel = new URL(createOrder.mock.calls[0][0].cancelUrl)
  const saved = (await conversations.get(id))!
  const p = page(saved.turns, owner, async body => {
    const events: ScoutEvent[] = []
    await buyTurn(String(body.conversation), String(body.card), deps, async e => { events.push(e) }, 'paypal', String(body.owner), undefined, undefined, Number(body.quote))
    return events
  })
  await p.context.load(cancel.pathname.split('/').at(-1)!)
  expect(p.redirects).toEqual([])
  const button = p.chat.children.flatMap(el => [el, ...el.children]).find(el => el.dataset.resume === card.id)
  expect(button, 'owner has a visible resume action after cancellation').toBeDefined()
  expect(button!.textContent).toBe('Resume payment')
  await p.context.resume(button!)
  expect(p.redirects).toEqual(['https://paypal.test/approve/ORDER123'])
  expect(createOrder).toHaveBeenCalledTimes(1)
  expect(model.chat).toHaveBeenCalledTimes(1)
  const response = await paidReturn(new URL(`https://gift.test/paid?c=${id}&token=ORDER123`), { conversations, paypal })
  expect(response.status).toBe(303)
  expect(capture).toHaveBeenCalledTimes(1)
  expect((await conversations.get(id))?.state).toMatchObject({ purchases: [{ status: 'captured' }] })
})

const turns: ScoutEvent[][] = [[
  { t: 'run', conversation: 'return123', turn: 1, mode: 'live', said: 'A gift' },
  { t: 'cards', cards: [{ id: 't1c1', gift: 'A gift', why: 'Music', price_low: 20, price_high: 40, entity: { id: 'b', name: 'Fender', type: 'brand' }, seeds: [], from_call: 1 }], dropped: [] },
  { t: 'order', card: 't1c1', gift: 'A gift', order_id: 'ORDER123', amount: '30.00', method: 'paypal', approve_url: 'https://paypal.test/approve/ORDER123' },
]]
it('keeps ordinary share visitors read only', async () => {
  const p = page(turns, null)
  await p.context.load('return123')
  expect(p.chat.children.flatMap(el => [el, ...el.children]).some(el => el.dataset.resume)).toBe(false)
  expect(p.context.canBuy).toBe(false)
  expect(p.context.composer.hidden).toBe(true)
  expect(p.redirects).toEqual([])
})

it('does not offer recovery for a paid order', async () => {
  const p = page([...turns, [{ t: 'paid', card: 't1c1', gift: 'A gift', order_id: 'ORDER123', capture_id: 'CAP1', amount: '30.00', at: '2026-11-05' }]], 'owner')
  await p.context.load('return123')
  expect(p.chat.children.flatMap(el => [el, ...el.children]).some(el => el.dataset.resume)).toBe(false)
})

it('keeps a confirmed order closed when an older resume event follows its receipt', async () => {
  const paid: ScoutEvent = { t: 'paid', card: 't1c1', gift: 'A gift', order_id: 'ORDER123', capture_id: 'CAP1', amount: '30.00', at: '2026-11-05' }
  const p = page([[...turns[0], paid], [turns[0].at(-1)!]], 'owner')
  await p.context.load('return123')
  expect(p.chat.children.flatMap(el => [el, ...el.children]).some(el => el.dataset.resume)).toBe(false)
})

it('keeps an uncertain payment available to check after a connection failure', async () => {
  const p = page(turns, 'owner', async () => { throw new Error('connection lost') })
  await p.context.load('return123')
  const button = p.chat.children.flatMap(el => [el, ...el.children]).find(el => el.dataset.resume)!
  await p.context.resume(button)
  expect(button.textContent).toBe('Resume payment')
  expect(p.context.busy).toBe(false)
  expect(p.errors).toEqual(['We could not confirm the payment. Tap Pay again to check, or check PayPal.'])
})

