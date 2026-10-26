import { describe, expect, it, vi } from 'vitest'
import { Channel3Client, CHANNEL3_CACHE_SECONDS, type GiftProduct } from '../../src/channel3/client'
import type { Cache } from '../../src/qloo/client'

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
    expect(result).toEqual({ ok: true, products: [{ id: 'fake-1', title: 'Made up gift', brand: 'Example Brand', price: 12.5, currency: 'USD', url: 'https://example.com/buy', image: 'https://example.com/image.jpg' }] satisfies GiftProduct[] })
  })

  it('uses a seven day cache hit without a fetch or cap', async () => {
    const cache = new MemoryCache()
    let expiry: number | undefined
    const put = cache.put.bind(cache)
    cache.put = async (key, value, opts) => { expiry = opts?.expirationTtl; await put(key, value) }
    const fetcher = vi.fn(async () => response({ products: [product()] }))
    const allow = vi.fn(async () => true)
    const first = new Channel3Client('secret-key', fetcher, cache, allow)
    expect((await first.search('A   GIFT', { limit: 4, maxPrice: 20 })).ok).toBe(true)
    expect(expiry).toBe(CHANNEL3_CACHE_SECONDS)
    fetcher.mockClear()
    allow.mockClear()
    const second = new Channel3Client('secret-key', fetcher, cache, allow)
    expect(await second.search('a gift', { limit: 4, maxPrice: 20 })).toEqual(await first.search('a gift', { limit: 4, maxPrice: 20 }))
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
