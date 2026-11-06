import { afterEach, expect, it, vi } from 'vitest'
import { newState, pickProduct } from '../../src/agent/agent'
import { buyTurn, ownerToken } from '../../src/app/buy'
import type { ScoutEvent } from '../../src/agent/events'
import type { GiftProduct } from '../../src/channel3/client'
import { PayPal } from '../../src/paypal/client'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

function product(title: string, category?: string): GiftProduct {
  return { id: 'fender1', title, brand: 'Fender', price: 30, currency: 'USD', url: 'https://shop.test/guitar',
    ...(category ? { category: { slug: category, title: category, path: [category] } } : {}) }
}
const pick = (title: string, gift = 'A Fender electric guitar', category?: string) =>
  pickProduct({ ok: true, cached: false, products: [product(title, category)] }, 'Fender', 'brand', 50, gift)
const dbs: FakeD1[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

it.each(['keychain', 'key ring', 'toy', 'miniature', 'replica', 'figurine', 'sticker', 'magnet', 'enamel pin', 'ornament', 'plush'])('does not attach guitar merchandise as a guitar: %s', object => {
  expect(pick(`Fender electric guitar ${object}`)).toBeUndefined()
})

it('rejects merchandise identified only by its category', () => {
  expect(pick('Fender electric guitar', undefined, 'Keychains')).toBeUndefined()
})

it.each(['keychain', 'toy', 'miniature replica', 'sticker', 'magnet', 'enamel pin', 'ornament', 'plush'])('accepts explicitly requested merchandise: %s', object => {
  expect(pick(`Fender electric guitar ${object}`, `A Fender electric guitar ${object}`)?.product).toBeDefined()
})

it('still attaches an actual guitar', () => {
  expect(pick('Fender electric guitar')?.product).toBeDefined()
})

it.each(['Fender electric guitar keychain', 'Fender miniature electric guitar replica'])('removes a refreshed merchandise offer before payment: %s', async title => {
  const db = new FakeD1(); dbs.push(db)
  const conversations = new Conversations(db), id = 'merch123'
  const item = { ...product('Fender electric guitar'), source: 'channel3' as const }
  const state = { ...newState(id), turn: 1, cards: [{ id: 't1c1', gift: 'A Fender electric guitar', why: 'A gift',
    price_low: 20, price_high: 50, entity: { id: 'brand', name: 'Fender', type: 'brand' }, seeds: [], from_call: 1, product: item }] }
  await conversations.put(id, state, [])
  const model = { name: 'test', chat: vi.fn(async () => { throw new Error('must stop before model') }) }
  const createOrder = vi.fn(), events: ScoutEvent[] = []
  await buyTurn(id, 't1c1', { conversations, ownerSecret: 'test', origin: 'https://gift.test',
    paypal: Object.assign(new PayPal('test', 'test', fetch), { createOrder }),
    live: { model, takeVisitorBuy: async () => true, budget: { allow: async () => true, reserve: async () => ({ settle: async () => {} }) } },
    products: { product: async () => ({ ok: true, product: product(title) }) },
  }, async event => { events.push(event) }, 'card', await ownerToken(id, 'test'), undefined, item)
  expect.soft(events).toContainEqual({ t: 'offer_gone', card: 't1c1', title: item.title })
  expect.soft((await conversations.get(id))?.state.cards[0].product).toBeUndefined()
  expect(model.chat).not.toHaveBeenCalled()
  expect(createOrder).not.toHaveBeenCalled()
})
