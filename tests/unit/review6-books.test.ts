import { afterEach, expect, it, vi } from 'vitest'
import { newState, pickProduct } from '../../src/agent/agent'
import { buyTurn, ownerToken } from '../../src/app/buy'
import type { ScoutEvent } from '../../src/agent/events'
import type { GiftProduct } from '../../src/channel3/client'
import { PayPal } from '../../src/paypal/client'
import { Conversations } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const product = (title: string): GiftProduct => ({ id: 'book1', title, price: 30, currency: 'USD', url: 'https://shop.test/book' })
const pick = (title: string, entity = 'Dune') => pickProduct({ ok: true, cached: false, products: [product(title)] }, entity, 'book', 50, `A copy of ${entity}.`)
const dbs: FakeD1[] = []
afterEach(() => { dbs.splice(0).forEach(db => db.close()) })

it.each(['Dune Messiah', 'Children of Dune', 'Dune, Messiah', 'Dune (Messiah Paperback)', 'Dune: Another Work', 'Dune [Children edition]', 'Dune (Deluxe Messiah Edition)'])('rejects a distinct book at attachment: %s', title => {
  expect(pick(title)).toBeUndefined()
})

it.each(['Dune', 'Dune (Paperback)', 'Dune [Large Print]', 'Dune, Second Edition', 'Dune Hardcover', 'Dune (50th Anniversary Edition)', 'Dune (Deluxe Edition)'])('accepts the same book with recognized metadata: %s', title => {
  expect(pick(title)?.product.title).toBe(title)
})

it('preserves meaningful subtitles and title words', () => {
  expect(pick('Dune', 'Dune: Messiah')).toBeUndefined()
  expect(pick('Dune: Messiah (Paperback)', 'Dune: Messiah')?.product).toBeDefined()
  expect(pick('The Edition (Paperback)', 'The Edition')?.product).toBeDefined()
})

it.each(['Dune Messiah', 'Children of Dune'])('removes a distinct refreshed book before payment: %s', async title => {
  const db = new FakeD1(); dbs.push(db)
  const conversations = new Conversations(db), id = 'books123'
  const item = { ...product('Dune'), source: 'channel3' as const }
  await conversations.put(id, { ...newState(id), turn: 1, cards: [{ id: 't1c1', gift: 'A copy of Dune.', why: 'A gift',
    price_low: 20, price_high: 50, entity: { id: 'book', name: 'Dune', type: 'book' }, seeds: [], from_call: 1, product: item }] }, [])
  const model = { name: 'test', chat: vi.fn(async () => { throw new Error('must stop before payment') }) }
  const createOrder = vi.fn(), events: ScoutEvent[] = []
  await buyTurn(id, 't1c1', { conversations, ownerSecret: 'test', origin: 'https://gift.test',
    paypal: Object.assign(new PayPal('test', 'test', fetch), { createOrder }),
    live: { model, takeVisitorBuy: async () => true, budget: { allow: async () => true, reserve: async () => ({ settle: async () => {} }) } },
    products: { product: async () => ({ ok: true, product: product(title) }) },
  }, async event => { events.push(event) }, 'paypal', await ownerToken(id, 'test'), undefined, item)
  expect.soft(events).toContainEqual({ t: 'offer_gone', card: 't1c1', title: 'Dune' })
  expect.soft((await conversations.get(id))?.state.cards[0].product).toBeUndefined()
  expect(events.some(e => e.t === 'offer_changed')).toBe(false)
  expect(model.chat).not.toHaveBeenCalled()
  expect(createOrder).not.toHaveBeenCalled()
})
