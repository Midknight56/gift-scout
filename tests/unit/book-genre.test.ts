import { describe, expect, it } from 'vitest'
import { pickProduct } from '../../src/agent/agent'
import { genresAgree } from '../../src/agent/product-type'
import { Channel3Client, type GiftProduct } from '../../src/channel3/client'
import { toEntity } from '../../src/qloo/client'

const book = (genres?: string[]): GiftProduct => ({ id: 'b', title: 'Fallen Angel', price: 9.99, currency: 'USD', url: 'https://buy.example.com/b',
  category: { slug: 'books', title: 'Books', path: ['books'] }, ...(genres ? { genres } : {}) })
const crime = ['Mystery', 'Travel', 'British Literature', 'Psychological Thriller', 'Crime']

describe('a book listing must share a genre family with the taste graph book', () => {
  it('rejects a fantasy book with the same title as a crime novel', () => {
    expect(genresAgree(crime, ['Fantasy', 'Sci-fi', 'Historical fiction'])).toBe(false)
    expect(pickProduct({ ok: true, cached: false, products: [book(['Fantasy'])] }, 'Fallen Angel', 'book', 40, 'Fallen Angel', crime)).toBeUndefined()
  })

  it('keeps a crime listing and keeps a listing when either side has no genre', () => {
    expect(genresAgree(crime, ['Crime & mystery', 'Thriller & suspense'])).toBe(true)
    expect(pickProduct({ ok: true, cached: false, products: [book(['Crime & mystery'])] }, 'Fallen Angel', 'book', 40, 'Fallen Angel', crime)?.product.title).toBe('Fallen Angel')
    expect(pickProduct({ ok: true, cached: false, products: [book()] }, 'Fallen Angel', 'book', 40, 'Fallen Angel', crime)?.product.title).toBe('Fallen Angel')
    expect(pickProduct({ ok: true, cached: false, products: [book(['Fantasy'])] }, 'Fallen Angel', 'book', 40, 'Fallen Angel')?.product.title).toBe('Fallen Angel')
    expect(genresAgree(['Audiobook', 'Fiction'], ['Fantasy'])).toBe(true)
  })

  it('reads genres from the shop data and from the taste graph tags of a book', async () => {
    const raw = { id: 'p', title: 'Fallen Angel', structured_attributes: { genre: ['Fantasy', 'Romance'] }, offers: [{ url: 'https://buy.example.com/p', price: { price: 9.99, currency: 'USD' } }] }
    const client = new Channel3Client('k', (async () => new Response(JSON.stringify({ products: [raw] }))) as unknown as typeof fetch, { get: async () => null, put: async () => {} }, async () => true)
    const result = await client.search('Fallen Angel book')
    expect(result.ok && result.products[0].genres).toEqual(['Fantasy', 'Romance'])
    expect(toEntity({ entity_id: 'e', name: 'Fallen Angel', types: ['urn:entity:book'], tags: crime.map((name) => ({ name })) }).tags).toEqual(crime)
  })
})
