// A small client for Qloo's Taste AI API on the hackathon server. Three calls: /search turns a name into a Qloo entity,
// /v2/tags turns a word like "Korean" into tag ids, and /v2/insights walks the taste graph from seed entities and tags
// to the entities of one type that the same people like, each with an affinity score from 0 to 1. Every answer is cached by its arguments, so a repeated question costs no
// Qloo call, and an upstream call happens only when the daily caps allow it.
export const QLOO_BASE = 'https://hackathon.api.qloo.com'
export const ENTITY_TYPES = ['artist', 'book', 'brand', 'destination', 'movie', 'person', 'place', 'podcast', 'tv_show', 'video_game'] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

/** A cached answer stays this long: past the end of judging, so the demo seeds never need Qloo twice. */
export const CACHE_SECONDS = 60 * 24 * 3600

export interface Entity {
  id: string
  name: string
  type: string
  /** 0 to 1, how strongly the seeds' audience likes this entity (insights only). */
  affinity?: number
  /** Qloo's split of how much each entity seed contributed to this result. */
  shares?: { id: string; share: number }[]
  popularity?: number
  detail?: string
  address?: string
  tags: string[]
}

export interface Cache {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

/** A tag from /v2/tags, for example "Korean" as a cuisine: `urn:tag:cuisine:qloo:korean`. */
export interface Tag {
  id: string
  name: string
  /** The tag's kind, for example "cuisine" or "genre:place". */
  kind: string
  /** The entity types it can describe or filter, for example ["place"]. */
  for: string[]
}

/** What one Qloo question gave, and whether it came from the cache (no Qloo call). */
export interface Answer<T> { results: T[]; cached: boolean }

export const TAG_ID = /^urn:tag:[a-z0-9_.:-]{3,120}$/
/** Qloo's audience signals (docs.qloo.com/reference/parameters, read 23 Oct 2026). */
export const AGES = ['24_and_younger', '25_to_29', '30_to_34', '35_to_44', '45_to_54', '55_and_older'] as const
export const GENDERS = ['male', 'female'] as const
/** Tags for one dish or one room feature: "single malt" found "Single Malt Water Bottle" (a dish), never a taste. */
const NOISE_TAG = /^urn:tag:(specialty_dish|menu_highlight|room_type|sustainability_iniative):/

export class QlooError extends Error {}

export class QlooBusy extends QlooError {
  constructor() { super('Gift Scout has asked Qloo enough questions for today. Try again tomorrow.') }
}

/** No key is set: only questions already in the cache or the recorded samples can be answered. */
export class QlooOff extends QlooError {
  constructor() { super('Live Qloo is off right now, so only the three examples work.') }
}

interface RawTag { id?: string; name?: string; type?: string; parents?: { type?: string }[] }

function toTag(raw: RawTag): Tag {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    kind: (raw.type ?? '').replace(/^urn:tag:/, ''),
    for: (raw.parents ?? []).map((p) => (p.type ?? '').replace(/^urn:entity:/, '')).filter(Boolean),
  }
}

interface RawEntity {
  entity_id?: string
  name?: string
  types?: string[]
  subtype?: string
  popularity?: number
  query?: { affinity?: number; explainability?: Record<string, unknown> }
  properties?: { short_description?: string; address?: string }
  tags?: { name?: string }[]
}

function shortType(raw: RawEntity): string {
  const urn = raw.subtype ?? raw.types?.[0] ?? ''
  return urn.replace(/^urn:entity:/, '')
}

export function toEntity(raw: RawEntity): Entity {
  const e: Entity = { id: raw.entity_id ?? '', name: raw.name ?? '', type: shortType(raw), tags: [] }
  if (typeof raw.query?.affinity === 'number') e.affinity = Math.round(raw.query.affinity * 1000) / 1000
  if (typeof raw.popularity === 'number') e.popularity = Math.round(raw.popularity * 1000) / 1000
  const detail = raw.properties?.short_description
  if (detail) e.detail = detail.length > 200 ? detail.slice(0, 197) + '...' : detail
  if (raw.properties?.address) e.address = raw.properties.address
  e.tags = (raw.tags ?? []).map((t) => t.name ?? '').filter(Boolean).slice(0, 5)
  return e
}

function entityShares(raw: RawEntity): Entity['shares'] {
  const explainability = raw.query?.explainability
  if (!explainability || typeof explainability !== 'object' || 'warning' in explainability) return undefined
  const entries = explainability['signal.interests.entities']
  if (!Array.isArray(entries)) return undefined
  const shares = entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const { entity_id, score } = entry as { entity_id?: unknown; score?: unknown }
    return typeof entity_id === 'string' && entity_id.length > 0 && typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1
      ? [{ id: entity_id, share: score }]
      : []
  }).sort((a, b) => b.share - a.share)
  return shares.length ? shares : undefined
}

export class QlooClient {
  constructor(
    private key: string,
    private fetcher: typeof fetch,
    private cache: Cache,
    /** Takes one upstream call from the daily caps; false when a cap is spent. */
    private allow: () => Promise<boolean>,
    /** Receives a valid monthly remaining count from an upstream response, and the seconds until the month resets. */
    private onQuota?: (remaining: number, resetSeconds?: number) => void | Promise<void>,
  ) {}

  /** With no type, Qloo ranks every kind together; measured 23 Oct 2026, that put "John le Carré" (an author, a type a
   *  typed search never returns) first for "Le Carre", where a book search gave a Wheel of Time novel. */
  async search(query: string, type: EntityType | undefined, take = 5): Promise<Answer<Entity>> {
    const params: Record<string, string> = { query: query.trim() }
    if (type) params.types = 'urn:entity:' + type
    params.take = String(take)
    const { body, cached } = await this.get('/search', params)
    return { results: ((body.results as RawEntity[] | undefined) ?? []).map(toEntity), cached }
  }

  /** Tags whose name matches, for a cuisine, a hobby or a genre that is not one entity. */
  async tags(query: string, take = 6): Promise<Answer<Tag>> {
    const { body, cached } = await this.get('/v2/tags', { 'filter.query': query.trim(), take: String(take) })
    const raw = ((body.results as { tags?: RawTag[] } | undefined)?.tags ?? [])
    return { results: raw.filter((t) => t.id && TAG_ID.test(t.id) && !NOISE_TAG.test(t.id)).map(toTag), cached }
  }

  async insights(opts: {
    seedIds: string[]; seedTags?: string[]; filterTags?: string[]; type: EntityType; location?: string; take?: number
    age?: (typeof AGES)[number]; gender?: (typeof GENDERS)[number]; resultIds?: string[]
  }): Promise<Answer<Entity>> {
    const params: Record<string, string> = { 'filter.type': 'urn:entity:' + opts.type }
    if (opts.seedIds.length) params['signal.interests.entities'] = opts.seedIds.join(',')
    if (opts.seedTags?.length) params['signal.interests.tags'] = opts.seedTags.join(',')
    if (opts.filterTags?.length) params['filter.tags'] = opts.filterTags.join(',')
    if (opts.resultIds?.length) params['filter.results.entities'] = opts.resultIds.join(',')
    // Measured 23 Oct 2026: for John le Carré and Lagavulin, age 55_and_older with gender male moved Ardbeg and Guinness
    // into the brands and Dan Carlin's Hardcore History into the podcasts.
    if (opts.age) params['signal.demographics.age'] = opts.age
    if (opts.gender) params['signal.demographics.gender'] = opts.gender
    // Measured 22 Oct 2026: "Toronto" turned places into Toronto shops and galleries; for brands Qloo accepted it and
    // gave the same top two, so it is sent for places only.
    if (opts.location && opts.type === 'place') params['filter.location.query'] = opts.location.trim()
    params['feature.explainability'] = 'true'
    params.take = String(opts.take ?? 8)
    const { body, cached } = await this.get('/v2/insights', params)
    const results = body.results as { entities?: RawEntity[] } | undefined
    return { results: (results?.entities ?? []).map((raw) => {
      const entity = toEntity(raw)
      const shares = entityShares(raw)
      if (shares) entity.shares = shares
      return entity
    }), cached }
  }

  private async get(path: string, params: Record<string, string>): Promise<{ body: Record<string, unknown>; cached: boolean }> {
    const url = path + '?' + new URLSearchParams(params).toString()
    const hit = await this.cache.get(url)
    if (hit) {
      try {
        const body = JSON.parse(hit) as Record<string, unknown>
        if (this.validBody(path, body)) return { body, cached: true }
      } catch { /* a corrupt cache entry is a miss */ }
    }
    if (!this.key) throw new QlooOff()
    if (!(await this.allow())) throw new QlooBusy()
    let res: Response
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try { res = await this.fetcher(QLOO_BASE + url, { headers: { 'X-Api-Key': this.key, Accept: 'application/json' }, signal: controller.signal }) }
      finally { clearTimeout(timer) }
    } catch { throw new QlooError('Qloo is not answering right now.') }
    const monthRemaining = res.headers.get('X-Month-RateLimit-Remaining')
    if (monthRemaining !== null && /^\d+$/.test(monthRemaining.trim())) {
      const remaining = Number(monthRemaining)
      if (Number.isSafeInteger(remaining)) {
        const reset = Number(res.headers.get('X-Month-RateLimit-Reset') ?? NaN)
        const resetSeconds = Number.isFinite(reset) && reset >= 0 ? reset : undefined
        try { void Promise.resolve(this.onQuota?.(remaining, resetSeconds)).catch(() => {}) } catch { /* quota bookkeeping never holds an answer */ }
      }
    }
    if (res.status === 429) throw new QlooBusy()
    if (res.status === 404) return { body: { results: [] }, cached: false } // the spec's "No results"
    if (!res.ok) {
      let why = ''
      try { why = ((await res.json()) as { errors?: { message?: string }[] }).errors?.[0]?.message ?? '' } catch { /* non-JSON */ }
      // Qloo's error text helps explain invalid taste ids; strip our credential before it can reach a visitor.
      if (this.key) why = why.split(this.key).join('[redacted]')
      throw new QlooError(why ? 'Qloo said: ' + why : 'Qloo said: HTTP ' + res.status)
    }
    let body: Record<string, unknown>
    try {
      const parsed: unknown = await res.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      body = parsed as Record<string, unknown>
    } catch { throw new QlooError('Qloo returned an unreadable answer.') }
    if (!this.validBody(path, body)) throw new QlooError('Qloo returned an incomplete answer.')
    await this.cache.put(url, JSON.stringify(body), { expirationTtl: CACHE_SECONDS })
    return { body, cached: false }
  }

  private validBody(path: string, body: Record<string, unknown>): boolean {
    if (path === '/search') return Array.isArray(body.results)
    const results = body.results
    if (!results || typeof results !== 'object' || Array.isArray(results)) return false
    return path === '/v2/tags'
      ? Array.isArray((results as { tags?: unknown }).tags)
      : Array.isArray((results as { entities?: unknown }).entities)
  }
}
