import { describe, expect, it, vi } from 'vitest'
import { Channel3Client, CHANNEL3_CACHE_SECONDS, type GiftProduct } from '../../src/channel3/client'
import type { Cache } from '../../src/qloo/client'
import { pickProduct } from '../../src/agent/agent'

class MemoryCache implements Cache {
  values = new Map<string, string>()
  async get(key: string) { return this.values.get(key) ?? null }
  async put(key: string, value: string, _opts?: { expirationTtl?: number }) { this.values.set(key, value) }
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fake-1', title: 'Made up gift', brands: [{ id: 'brand-1', name: 'Example Brand' }],
    images: [{ url: 'https://example.com/image.jpg' }],
    offers: [
      { url: 'https://example.com/unpriced', price: null },
      { url: 'https://example.com/buy', price: { price: 12.5, currency: 'USD' } },
      { url: 'https://example.com/later', price: { price: 14, currency: 'USD' } },
    ],
    ...overrides,
  }
}

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers })
}

describe('Channel3Client', () => {
  it('maps the first priced offer and skips products without a priced offer', async () => {
    const fetcher = vi.fn(async () => response({ products: [product(), product({ id: 'no-offer', offers: [{ url: 'https://example.com/none', price: null }] })] }))
    const client = new Channel3Client('secret-key', fetcher, new MemoryCache(), async () => true)
    const result = await client.search('gift')
    expect(result).toEqual({ ok: true, cached: false, products: [{ id: 'fake-1', title: 'Made up gift', brand: 'Example Brand', price: 12.5, currency: 'USD', url: 'https://example.com/buy', image: 'https://example.com/image.jpg' }] satisfies GiftProduct[] })
  })

  it('uses a seven day cache hit without a fetch or cap', async () => {
    const cache = new MemoryCache()
    let expiry: number | undefined
    const put = cache.put.bind(cache)
    cache.put = async (key, value, opts) => { expiry = opts?.expirationTtl; await put(key, value) }
    const fetcher = vi.fn(async () => response({ products: [product()] }))
    const allow = vi.fn(async () => true)
    const first = new Channel3Client('secret-key', fetcher, cache, allow)
    expect(await first.search('A   GIFT', { limit: 4, maxPrice: 20 })).toMatchObject({ ok: true, cached: false })
    expect(expiry).toBe(CHANNEL3_CACHE_SECONDS)
    fetcher.mockClear()
    allow.mockClear()
    const second = new Channel3Client('secret-key', fetcher, cache, allow)
    expect(await second.search('a gift', { limit: 4, maxPrice: 20 })).toMatchObject({ ok: true, cached: true })
    expect(fetcher).not.toHaveBeenCalled()
    expect(allow).not.toHaveBeenCalled()
  })

  it('does not fetch when the cap refuses', async () => {
    const fetcher = vi.fn()
    const result = await new Channel3Client('secret-key', fetcher, new MemoryCache(), async () => false).search('gift')
    expect(result).toEqual({ ok: false, reason: 'capped' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns spent for a 402 without retrying', async () => {
    const fetcher = vi.fn(async () => response({}, 402))
    const result = await new Channel3Client('secret-key', fetcher, new MemoryCache(), async () => true).search('gift')
    expect(result).toEqual({ ok: false, reason: 'spent' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 once and succeeds', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({}, 429, { 'Retry-After': '2' })).mockResolvedValueOnce(response({ products: [product()] }))
    const sleep = vi.fn(async () => {})
    const allow = vi.fn(async () => true)
    const result = await new Channel3Client('secret-key', fetcher, new MemoryCache(), allow, sleep).search('gift')
    expect(result.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(allow).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(2000)
  })

  it('returns error after two 429 responses', async () => {
    const fetcher = vi.fn(async () => response({}, 429, { 'Retry-After': '0' }))
    const result = await new Channel3Client('secret-key', fetcher, new MemoryCache(), async () => true, async () => {}).search('gift')
    expect(result).toEqual({ ok: false, reason: 'error' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('returns error when the request times out', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
      const searching = new Channel3Client('secret-key', fetcher, new MemoryCache(), async () => true).search('gift')
      await vi.advanceTimersByTimeAsync(8000)
      expect(await searching).toEqual({ ok: false, reason: 'error' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never includes the key in a result or thrown text', async () => {
    const key = 'private-test-key'
    const fetcher = vi.fn(async () => { throw new Error(`failure ${key}`) })
    let result: unknown
    let thrown: unknown
    try { result = await new Channel3Client(key, fetcher, new MemoryCache(), async () => true).search('gift') } catch (error) { thrown = error }
    expect(JSON.stringify(result)).not.toContain(key)
    expect(String(thrown ?? '')).not.toContain(key)
    expect(result).toEqual({ ok: false, reason: 'error' })
  })
})


describe('usable offers and fresh product details', () => {
  it('prefers a later USD offer to CAD and keeps it eligible for the book', async () => {
    const raw = product({ id: 'Original/ID', title: 'Fallen Angel', offers: [
      { url: 'https://shop.test/cad', price: { price: 25, currency: 'CAD' } },
      { url: 'https://shop.test/usd', price: { price: 20, currency: 'USD' } },
    ] })
    const client = new Channel3Client('key', async () => response({ products: [raw] }), new MemoryCache(), async () => true)
    const result = await client.search('Fallen Angel')
    expect(result).toMatchObject({ products: [{ id: 'Original/ID', currency: 'USD', price: 20, url: 'https://shop.test/usd' }] })
    expect(pickProduct(result, 'Fallen Angel', 'book', 40)?.product.id).toBe('Original/ID')
  })

  it('selects the lowest usable USD offer in search and product details', async () => {
    const raw = product({ offers: [
      { url: 'https://shop.test/first', price: { price: 25, currency: 'USD' } },
      { url: 'https://shop.test/used', price: { price: 5, currency: 'USD' }, condition: 'used' },
      { url: 'https://shop.test/gone', price: { price: 6, currency: 'USD' }, availability: 'OutOfStock' },
      { url: 'http://shop.test/insecure', price: { price: 7, currency: 'USD' } },
      { url: 'https://shop.test/best', price: { price: 20, currency: 'usd' } },
    ] })
    const client = new Channel3Client('key', async (input) => response(String(input).includes('/products/') ? raw : { products: [raw] }), new MemoryCache(), async () => true)
    expect(await client.search('gift')).toMatchObject({ products: [{ price: 20, currency: 'usd', url: 'https://shop.test/best' }] })
    expect(await client.product('fake-1')).toMatchObject({ product: { price: 20, currency: 'usd', url: 'https://shop.test/best' } })
  })

  it('keeps the category path in root order and preserves the original id', async () => {
    const raw = product({ id: 'Original/ID', category: { slug: 'fiction', title: 'Fiction', path: [
      { slug: 'books', title: 'Books' }, { slug: 'fiction', title: 'Fiction' },
    ], has_children: false } })
    const client = new Channel3Client('key', async () => response({ products: [raw] }), new MemoryCache(), async () => true)
    expect(await client.search('gift')).toMatchObject({ products: [{ id: 'Original/ID', category: { slug: 'fiction', title: 'Fiction', path: ['books', 'fiction'] } }] })
  })

  it.each([
    { price: { price: 20 } },
    { price: { price: 20, currency: 'US' } },
    { url: 'http://shop.test/item' },
    { availability: 'OutOfStock' },
    { condition: 'used' },
  ])('drops an unusable offer %j', async (bad) => {
    const offer = { url: 'https://shop.test/item', price: { price: 20, currency: 'USD' }, ...bad }
    const client = new Channel3Client('key', async () => response({ products: [product({ offers: [offer] })] }), new MemoryCache(), async () => true)
    expect(await client.search('gift')).toMatchObject({ ok: true, products: [] })
  })

  it('skips an unavailable offer and preserves the id, availability and condition', async () => {
    const offer = { url: 'https://shop.test/item', price: { price: 24, currency: 'USD' }, availability: 'InStock', condition: 'new' }
    const raw = product({ id: 'Original/ID', offers: [{ ...offer, availability: 'OutOfStock' }, offer] })
    const client = new Channel3Client('key', async () => response({ products: [raw] }), new MemoryCache(), async () => true)
    expect(await client.search('gift')).toMatchObject({ products: [{ id: 'Original/ID', availability: 'InStock', condition: 'new' }] })
  })

  it('fetches product details once through the cap and never touches the cache', async () => {
    const cache = { get: vi.fn(), put: vi.fn() }, allow = vi.fn(async () => true)
    const fetcher = vi.fn(async () => response(product({ id: 'Original/ID' })))
    const client = new Channel3Client('key', fetcher, cache, allow)
    expect(await client.product('Original/ID')).toMatchObject({ ok: true, product: { id: 'Original/ID', price: 12.5 } })
    expect(fetcher).toHaveBeenCalledWith('https://api.trychannel3.com/v1/products/Original%2FID', expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ 'x-api-key': 'key' }) }))
    expect(allow).toHaveBeenCalledTimes(1)
    expect(cache.get).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
  })

  it.each([404, 402, 500, 429])('handles detail status %s', async (status) => {
    const client = new Channel3Client('key', async () => response({}, status), new MemoryCache(), async () => true)
    expect(await client.product('id')).toEqual({ ok: false, reason: status === 404 ? 'gone' : status === 402 ? 'spent' : 'error' })
  })

  it('returns gone when no usable offer remains', async () => {
    const client = new Channel3Client('key', async () => response(product({ offers: [] })), new MemoryCache(), async () => true)
    expect(await client.product('id')).toEqual({ ok: false, reason: 'gone' })
  })

  it('does not fetch when details are off or capped', async () => {
    const fetcher = vi.fn()
    expect(await new Channel3Client('', fetcher, new MemoryCache(), async () => true).product('id')).toEqual({ ok: false, reason: 'off' })
    expect(await new Channel3Client('key', fetcher, new MemoryCache(), async () => false).product('id')).toEqual({ ok: false, reason: 'capped' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('the shop behind an offer', () => {
  it('keeps the offer domain as the merchant, not the redirect link host', async () => {
    const raw = product({ offers: [{ url: 'https://buy.trychannel3.com/abc?o=1', domain: 'barnesandnoble.com', price: { price: 9.99, currency: 'USD' } }] })
    const fetcher = vi.fn(async () => response({ products: [raw] }))
    const client = new Channel3Client('key', fetcher as unknown as typeof fetch, new MemoryCache(), async () => true)
    const result = await client.search('Fallen Angel book')
    expect(result.ok && result.products[0].merchant).toBe('barnesandnoble.com')
  })
})
