import { afterEach, describe, expect, it, vi } from 'vitest'
import { newState, pickProduct } from '../../src/agent/agent'
import { buyTurn, ownerToken } from '../../src/app/buy'
import type { ScoutEvent } from '../../src/agent/events'
import type { GiftProduct } from '../../src/channel3/client'
import { PayPal } from '../../src/paypal/client'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

function product(title: string, category?: string): GiftProduct {
  return { id: 'product1', title, brand: 'Lagavulin', price: 30, currency: 'USD', url: 'https://shop.test/item',
    ...(category ? { category: { slug: category.toLowerCase(), title: category, path: [category] } } : {}) }
}
const pick = (item: GiftProduct, gift: string, entity = 'Lagavulin') => pickProduct({ ok: true, cached: false, products: [item] }, entity, 'brand', 50, gift)
const dbs: FakeD1[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

describe('review 5: the intended gift type', () => {
  it.each([
    ['A bottle of Lagavulin 16 year, 750 ml whisky', 'Lagavulin 8 Year 200 ml whisky'],
    ['A bottle of Lagavulin 16 year whisky', 'Lagavulin 8 Year whisky'],
    ['A bottle of Lagavulin 750 ml whisky', 'Lagavulin 200 ml whisky'],
    ['A bottle of Lagavulin 16 year, 750 ml whisky', 'Lagavulin whisky bottle'],
    ['A Lagavulin shirt size XL', 'Lagavulin shirt size S'],
    ['A Lagavulin shirt size XL', 'Lagavulin shirt'],
    ['A Lagavulin mug model X100', 'Lagavulin mug model X200'],
    ['A Lagavulin X100 mug', 'Lagavulin X200 mug'],
    ['A Lagavulin hardcover book', 'Lagavulin paperback book'],
    ['A Lagavulin hardcover book', 'Lagavulin book'],
  ])('rejects a conflicting or unverified variant: %s versus %s', (gift, title) => {
    expect(pick(product(title), gift)).toBeUndefined()
  })
  it.each([
    ['A bottle of Lagavulin 16 year, 750 ml whisky', 'Lagavulin 16 Year 750 ml whisky'],
    ['A bottle of Lagavulin 0.75 L whisky', 'Lagavulin 750 ml whisky'],
    ['A Lagavulin shirt size XL', 'Lagavulin extra large shirt'],
    ['A Lagavulin mug model X100', 'Lagavulin X100 mug'],
    ['A Lagavulin hardcover book', 'Lagavulin hardback book'],
  ])('accepts a verified equivalent variant: %s versus %s', (gift, title) => {
    expect(pick(product(title), gift)?.product.title).toBe(title)
  })
  it.each([
    ['A bottle of Lagavulin whisky', 'Lagavulin whisky glass', 'Drinkware'],
    ['A Fender guitar strap', 'Fender guitar', 'Musical instruments'],
    ['A Phoebe Bridgers vinyl record', 'Phoebe Bridgers record poster', 'Posters'],
    ['A Lagavulin mug', 'Lagavulin shirt', 'Clothing'],
    ['A Lagavulin candle', 'Lagavulin candle holder', 'Home decor'],
    ['A Lagavulin gift card', 'Lagavulin whisky', 'Spirits'],
    ['A Lagavulin surprise', 'Lagavulin collectible', 'Collectibles'],
    ['A bottle of Lagavulin whisky', 'Lagavulin', ''],
  ])('keeps %s as an idea instead of attaching %s', (gift, title, category) => {
    const entity = gift.includes('Fender') ? 'Fender' : gift.includes('Phoebe') ? 'Phoebe Bridgers' : 'Lagavulin'
    expect(pick(product(title, category), gift, entity)).toBeUndefined()
  })
  it.each([
    ['A bottle of Lagavulin whisky', 'Lagavulin 16 Year 750 ml', 'Spirits'],
    ['A Fender guitar strap', 'Fender woven strap', 'Guitar straps'],
    ['A Phoebe Bridgers vinyl record', 'Phoebe Bridgers Punisher LP', 'Vinyl records'],
    ['A Lagavulin mug', 'Lagavulin ceramic mug', 'Drinkware'],
    ['A Lagavulin candle', 'Lagavulin scented candle', 'Candles'],
    ['A Lagavulin gift card', 'Lagavulin gift voucher', 'Gift cards'],
  ])('accepts sufficient evidence for %s', (gift, title, category) => {
    const entity = gift.includes('Fender') ? 'Fender' : gift.includes('Phoebe') ? 'Phoebe Bridgers' : 'Lagavulin'
    expect(pick(product(title, category), gift, entity)?.product.title).toBe(title)
  })
  it.each(['type', 'variant', 'selected variant'])('stops a purchase when the refreshed item has the wrong %s at the same price', async fault => {
    const db = new FakeD1(); dbs.push(db)
    const conversations = new Conversations(db), id = 'types123'
    const item = { ...product(fault === 'type' ? 'Lagavulin whisky bottle' : 'Lagavulin 16 Year 750 ml whisky', 'Spirits'), source: 'channel3' as const }
    const gift = fault === 'variant' ? 'A bottle of Lagavulin 16 year, 750 ml whisky' : 'A bottle of Lagavulin whisky'
    const state = { ...newState(id), turn: 1, cards: [{ id: 't1c1', gift, why: 'A gift',
      price_low: 20, price_high: 50, entity: { id: 'brand', name: 'Lagavulin', type: 'brand' }, seeds: [], from_call: 1, product: item }] }
    await conversations.put(id, state, [])
    const model = { name: 'test', chat: vi.fn(async () => { throw new Error('must stop before model') }) }
    const createOrder = vi.fn(), events: ScoutEvent[] = []
    await buyTurn(id, 't1c1', { conversations, ownerSecret: 'test', origin: 'https://gift.test',
      paypal: Object.assign(new PayPal('test', 'test', fetch), { createOrder }),
      live: { model, takeVisitorBuy: async () => true, budget: { allow: async () => true, reserve: async () => ({ settle: async () => {} }) } },
      products: { product: async () => ({ ok: true, product: fault === 'type' ? product('Lagavulin whisky glass', 'Drinkware') : product('Lagavulin 8 Year 200 ml whisky', 'Spirits') }) },
    }, async e => { events.push(e) }, 'card', await ownerToken(id, 'test'), undefined, item)
    expect(events).toContainEqual({ t: 'offer_gone', card: 't1c1', title: item.title })
    expect((await conversations.get(id))?.state.cards[0].product).toBeUndefined()
    expect(model.chat).not.toHaveBeenCalled()
    expect(createOrder).not.toHaveBeenCalled()
  })
})
