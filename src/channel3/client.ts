import type { Cache } from '../qloo/client'

export const CHANNEL3_BASE = 'https://api.trychannel3.com/v1/search'
export const CHANNEL3_CACHE_SECONDS = 7 * 24 * 60 * 60

export interface GiftProduct {
  id: string
  title: string
  brand?: string
  price: number
  currency: string
  url: string
  image?: string
}

export type SearchResult =
  | { ok: true; products: GiftProduct[] }
  | { ok: false; reason: 'off' | 'capped' | 'spent' | 'error' }

interface RawProduct {
  id?: unknown
  title?: unknown
  brands?: { name?: unknown }[]
  images?: { url?: unknown; cleaned_url?: unknown }[]
  offers?: { url?: unknown; price?: { price?: unknown; currency?: unknown } | null }[]
}

function mapProduct(raw: RawProduct): GiftProduct | null {
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null
  const offer = (raw.offers ?? []).find((item) =>
    typeof item.url === 'string' && typeof item.price?.price === 'number' && Number.isFinite(item.price.price),
  )
  if (!offer || typeof offer.url !== 'string' || typeof offer.price?.price !== 'number') return null
  const product: GiftProduct = {
    id: raw.id,
    title: raw.title,
    price: offer.price.price,
    currency: typeof offer.price.currency === 'string' ? offer.price.currency : 'USD',
    url: offer.url,
  }
  const brand = raw.brands?.[0]?.name
  if (typeof brand === 'string' && brand) product.brand = brand
  const image = raw.images?.[0]
  if (typeof image?.cleaned_url === 'string') product.image = image.cleaned_url
  else if (typeof image?.url === 'string') product.image = image.url
  return product
}

function retrySeconds(value: string | null): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 5) : 0
}

export class Channel3Client {
  constructor(
    private key: string,
    private fetcher: typeof fetch,
    private cache: Cache,
    /** Takes one upstream call from the daily caps; false when a cap is spent. */
    private allow: () => Promise<boolean>,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async search(query: string, opts: { limit?: number; maxPrice?: number } = {}): Promise<SearchResult> {
    if (!this.key) return { ok: false, reason: 'off' }
    const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase()
    const limit = opts.limit
    const maxPrice = opts.maxPrice
    const cacheKey = `channel3:${JSON.stringify({ query: normalized, limit, maxPrice })}`
    try {
      const hit = await this.cache.get(cacheKey)
      if (hit !== null) {
        const products = JSON.parse(hit) as GiftProduct[]
        if (Array.isArray(products)) return { ok: true, products }
      }
      const body: { query: string; limit?: number; filters?: { price: { max_price: number } } } = { query: query.trim() }
      if (limit !== undefined) body.limit = limit
      if (maxPrice !== undefined) body.filters = { price: { max_price: maxPrice } }
      const payload = JSON.stringify(body)

      for (let attempt = 0; attempt < 2; attempt++) {
        if (!(await this.allow())) return { ok: false, reason: 'capped' }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 8000)
        let response: Response
        let data: { products?: unknown } | undefined
        try {
          response = await this.fetcher(CHANNEL3_BASE, {
            method: 'POST',
            headers: { 'x-api-key': this.key, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: payload,
            signal: controller.signal,
          })
          if (response.ok) data = await response.json() as { products?: unknown }
        } finally {
          clearTimeout(timer)
        }
        if (response.status === 402) return { ok: false, reason: 'spent' }
        if (response.status === 429 && attempt === 0) {
          const seconds = retrySeconds(response.headers.get('Retry-After'))
          if (seconds) await this.sleep(seconds * 1000)
          continue
        }
        if (!response.ok) return { ok: false, reason: 'error' }
        if (!Array.isArray(data?.products)) return { ok: false, reason: 'error' }
        const products = data.products.map((item) => mapProduct(item as RawProduct)).filter((item): item is GiftProduct => item !== null)
        await this.cache.put(cacheKey, JSON.stringify(products), { expirationTtl: CHANNEL3_CACHE_SECONDS })
        return { ok: true, products }
      }
      return { ok: false, reason: 'error' }
    } catch {
      return { ok: false, reason: 'error' }
    }
  }
}
