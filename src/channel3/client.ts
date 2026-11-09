import type { Cache } from '../qloo/client'

export const CHANNEL3_BASE = 'https://api.trychannel3.com/v1/search'
export const CHANNEL3_CACHE_SECONDS = 7 * 24 * 60 * 60

export interface GiftProduct {
  id: string
  title: string
  brand?: string
  /** The shop's own domain from the offer (the url is a redirect link). */
  merchant?: string
  price: number
  currency: string
  url: string
  image?: string
  availability?: 'InStock' | 'OutOfStock'
  condition?: 'new' | 'used'
  category?: { slug: string; title: string; path: string[] }
  /** Genres the shop gives a book, used to tell apart books that share a title. */
  genres?: string[]
}

export type SearchResult =
  | { ok: true; products: GiftProduct[]; cached: boolean }
  | { ok: false; reason: 'off' | 'capped' | 'spent' | 'error' }

export type ProductResult =
  | { ok: true; product: GiftProduct }
  | { ok: false; reason: 'off' | 'capped' | 'spent' | 'error' | 'gone' }

interface RawProduct {
  id?: unknown
  title?: unknown
  brands?: { name?: unknown }[]
  images?: { url?: unknown; cleaned_url?: unknown }[]
  offers?: { availability?: unknown; condition?: unknown; url?: unknown; domain?: unknown; price?: { price?: unknown; currency?: unknown } | null }[]
  category?: { slug?: unknown; title?: unknown; path?: { slug?: unknown; title?: unknown }[] } | null
  structured_attributes?: { genre?: unknown } | null
}

function mapProduct(raw: RawProduct): GiftProduct | null {
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null
  const usable = (raw.offers ?? []).filter((item) =>
    typeof item.url === 'string' && https(item.url) &&
    typeof item.price?.price === 'number' && Number.isFinite(item.price.price) &&
    typeof item.price.currency === 'string' && /^[a-z]{3}$/i.test(item.price.currency) &&
    item.availability !== 'OutOfStock' && item.condition !== 'used',
  )
  const offer = usable.filter((item) => String(item.price?.currency).toLowerCase() === 'usd')
    .sort((a, b) => Number(a.price?.price) - Number(b.price?.price))[0] ?? usable[0]
  if (!offer || typeof offer.url !== 'string' || typeof offer.price?.price !== 'number') return null
  const product: GiftProduct = {
    id: raw.id,
    title: raw.title,
    price: offer.price.price,
    currency: offer.price.currency as string,
    url: offer.url,
  }
  if (typeof offer.domain === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(offer.domain)) product.merchant = offer.domain.toLowerCase().replace(/^www\./, '')
  if (offer.availability === 'InStock') product.availability = offer.availability
  if (offer.condition === 'new') product.condition = offer.condition
  const brand = raw.brands?.[0]?.name
  if (typeof brand === 'string' && brand) product.brand = brand
  const image = raw.images?.[0]
  if (typeof image?.cleaned_url === 'string') product.image = image.cleaned_url
  else if (typeof image?.url === 'string') product.image = image.url
  const genre = raw.structured_attributes?.genre
  if (Array.isArray(genre)) {
    const genres = genre.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length < 60).slice(0, 5)
    if (genres.length) product.genres = genres
  }
  const category = raw.category
  if (typeof category?.slug === 'string' && typeof category.title === 'string') {
    product.category = { slug: category.slug, title: category.title, path: (category.path ?? []).flatMap((part) =>
      typeof part.slug === 'string' && part.slug ? [part.slug] : typeof part.title === 'string' ? [part.title] : []) }
  }
  return product
}

function https(value: string): boolean {
  try { return new URL(value).protocol === 'https:' } catch { return false }
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

  async product(id: string): Promise<ProductResult> {
    if (!this.key) return { ok: false, reason: 'off' }
    try {
      if (!(await this.allow())) return { ok: false, reason: 'capped' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const response = await this.fetcher(`https://api.trychannel3.com/v1/products/${encodeURIComponent(id)}`, {
          method: 'GET', headers: { 'x-api-key': this.key, Accept: 'application/json' }, signal: controller.signal,
        })
        if (response.status === 404) return { ok: false, reason: 'gone' }
        if (response.status === 402) return { ok: false, reason: 'spent' }
        if (!response.ok) return { ok: false, reason: 'error' }
        const raw = await response.json() as RawProduct
        if (!raw || typeof raw !== 'object') return { ok: false, reason: 'error' }
        const product = mapProduct(raw)
        return product ? { ok: true, product } : { ok: false, reason: 'gone' }
      } finally { clearTimeout(timer) }
    } catch { return { ok: false, reason: 'error' } }
  }

  async search(query: string, opts: { limit?: number; maxPrice?: number } = {}): Promise<SearchResult> {
    if (!this.key) return { ok: false, reason: 'off' }
    const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase()
    const limit = opts.limit
    const maxPrice = opts.maxPrice
    // v2: products now carry the shop domain and book genres.
    const cacheKey = `channel3:v2:${JSON.stringify({ query: normalized, limit, maxPrice })}`
    try {
      const hit = await this.cache.get(cacheKey)
      if (hit !== null) {
        const products = JSON.parse(hit) as GiftProduct[]
        if (Array.isArray(products)) return { ok: true, products, cached: true }
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
        return { ok: true, products, cached: false }
      }
      return { ok: false, reason: 'error' }
    } catch {
      return { ok: false, reason: 'error' }
    }
  }
}
