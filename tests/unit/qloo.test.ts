import { describe, expect, it } from 'vitest'
import { QLOO_BASE, QlooClient, QlooOff, type Cache } from '../../src/qloo/client'
import { qlooTools, searchEntities, type QlooContext } from '../../src/qloo/tools'
import { McpServer } from '../../src/mcp/server'

const KEY = 'hack_test_key_that_must_never_leak_0123456789'

// Shapes as Qloo answered them on 22 Oct 2026 (trimmed).
const SEARCH = { results: [{ entity_id: '00000000-0000-4000-8000-000000000001', name: 'Phoebe Bridgers', types: ['urn:entity:artist'], popularity: 0.97, properties: {}, tags: [] }] }
const INSIGHTS = {
  success: true,
  results: {
    entities: [
      { entity_id: 'F1', name: 'Fender', type: 'urn:entity', subtype: 'urn:entity:brand', popularity: 0.99, query: { affinity: 0.9307161828273967 },
        properties: { short_description: 'Fender is a leading manufacturer of electric and acoustic guitars.' }, tags: [{ name: 'Music Instruments' }] },
      { entity_id: 'P1', name: "The Monkey's Paw", type: 'urn:entity', subtype: 'urn:entity:place', query: { affinity: 0.8884 },
        properties: { short_description: 'Quirky antiquarian shop.', address: '1067 Bloor St W Toronto' }, tags: [] },
    ],
  },
}

const TAGS = { success: true, results: { tags: [
  { id: 'urn:tag:cuisine:qloo:korean', name: 'Korean', type: 'urn:tag:cuisine:qloo', parents: [{ type: 'urn:entity:place' }] },
  { id: 'not a tag id', name: 'Broken', type: 'x', parents: [] },
] } }

function memoryCache(): Cache & { size(): number } {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, size: () => m.size }
}

function fakeQloo(answer: (url: URL) => { status: number; body: unknown; headers?: HeadersInit }) {
  const calls: { url: URL; key: string | null }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, key: new Headers(init?.headers).get('X-Api-Key') })
    const { status, body, headers } = answer(url)
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers).entries()) } })
  }) as typeof fetch
  return { fetcher, calls }
}

function client(answer: (url: URL) => { status: number; body: unknown }, allow = async () => true) {
  const q = fakeQloo(answer)
  const cache = memoryCache()
  return { qloo: new QlooClient(KEY, q.fetcher, cache, allow), calls: q.calls, cache }
}

describe('Qloo client', () => {
  it('hands a whole monthly remaining header to its callback and ignores missing or bad headers', async () => {
    const seen: number[] = []
    const q = fakeQloo(() => ({ status: 200, body: SEARCH, headers: { 'X-Month-RateLimit-Remaining': '49535' } }))
    const client = new QlooClient(KEY, q.fetcher, memoryCache(), async () => true, (remaining) => { seen.push(remaining) })
    await client.search('Phoebe Bridgers', 'artist')
    expect(seen).toEqual([49535])

    for (const header of [undefined, 'bad', '3.5', '-1']) {
      const headers: HeadersInit = header === undefined ? {} : { 'X-Month-RateLimit-Remaining': header }
      const response = fakeQloo(() => ({ status: 200, body: SEARCH, headers }))
      const ignored = new QlooClient(KEY, response.fetcher, memoryCache(), async () => true, (remaining) => { seen.push(remaining) })
      await ignored.search('Phoebe Bridgers', 'artist')
    }
    expect(seen).toEqual([49535])
  })

  it('searches with the key in the X-Api-Key header and maps a result', async () => {
    const { qloo, calls } = client(() => ({ status: 200, body: SEARCH }))
    const { results: found, cached } = await qloo.search(' Phoebe Bridgers ', 'artist', 3)
    expect(cached).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(QLOO_BASE + '/search')
    expect(calls[0].url.searchParams.get('query')).toBe('Phoebe Bridgers')
    expect(calls[0].url.searchParams.get('types')).toBe('urn:entity:artist')
    expect(calls[0].url.searchParams.get('take')).toBe('3')
    expect(calls[0].key).toBe(KEY)
    expect(found).toEqual([{ id: '00000000-0000-4000-8000-000000000001', name: 'Phoebe Bridgers', type: 'artist', popularity: 0.97, tags: [] }])
  })

  it('asks insights for one type from the seeds, with the affinity, the detail and a place address', async () => {
    const { qloo, calls } = client(() => ({ status: 200, body: INSIGHTS }))
    const { results: out } = await qloo.insights({ seedIds: ['A', 'B'], type: 'place', location: 'Toronto', take: 2 })
    const p = calls[0].url.searchParams
    expect(calls[0].url.pathname).toBe('/v2/insights')
    expect(p.get('filter.type')).toBe('urn:entity:place')
    expect(p.get('feature.explainability')).toBe('true')
    expect(p.get('signal.interests.entities')).toBe('A,B')
    expect(p.get('filter.location.query')).toBe('Toronto')
    expect(out[0]).toMatchObject({ name: 'Fender', type: 'brand', affinity: 0.931, tags: ['Music Instruments'] })
    expect(out[1]).toMatchObject({ name: "The Monkey's Paw", type: 'place', address: '1067 Bloor St W Toronto' })
  })

  it('filters insights to the requested result ids', async () => {
    const { qloo, calls } = client(() => ({ status: 200, body: INSIGHTS }))
    await qloo.insights({ seedIds: ['A', 'B'], type: 'brand', resultIds: ['F1', 'F2'], take: 1 })
    expect(calls[0].url.searchParams.get('filter.results.entities')).toBe('F1,F2')
    expect(calls[0].url.searchParams.get('take')).toBe('1')
  })

  it('parses sorted Qloo entity shares and keeps only valid scores', async () => {
    const body = {
      results: { entities: [{ entity_id: 'E', name: 'Gift', subtype: 'urn:entity:brand', query: {
        affinity: 0.8, explainability: { 'signal.interests.entities': [
        { entity_id: 'LOW', score: 0.2 }, { entity_id: 'HIGH', score: 0.7 }, { entity_id: 'NAN', score: Number.NaN },
        { entity_id: 'NEG', score: -0.1 }, { entity_id: 'OVER', score: 1.1 }, { entity_id: 'TEXT', score: '0.5' },
        ] },
      } }] },
    }
    const { qloo } = client(() => ({ status: 200, body }))
    const [entity] = (await qloo.insights({ seedIds: ['HIGH', 'LOW'], type: 'brand' })).results
    expect(entity.shares).toEqual([{ id: 'HIGH', share: 0.7 }, { id: 'LOW', share: 0.2 }])
  })

  it.each([
    ['missing', {}],
    ['warning', { warning: 'explainability unavailable' }],
    ['malformed', { 'signal.interests.entities': 'not a list' }],
    ['out of range', { 'signal.interests.entities': [{ entity_id: 'BAD', score: 2 }] }],
  ])('omits shares when explainability is %s', async (_name, explainability) => {
    const { qloo } = client(() => ({ status: 200, body: { results: { entities: [{ entity_id: 'E', name: 'Gift', subtype: 'urn:entity:brand',
      query: _name === 'missing' ? { affinity: 0.8 } : { affinity: 0.8, explainability },
    }] } } }))
    const [entity] = (await qloo.insights({ seedIds: ['A'], type: 'brand' })).results
    expect(entity).not.toHaveProperty('shares')
  })

  it('sends a location only for places', async () => {
    const { qloo, calls } = client(() => ({ status: 200, body: INSIGHTS }))
    await qloo.insights({ seedIds: ['A'], type: 'brand', location: 'Toronto' })
    expect(calls[0].url.searchParams.has('filter.location.query')).toBe(false)
  })

  it('answers a repeated question from the cache, with no second Qloo call and no cap taken', async () => {
    let taken = 0
    const { qloo, calls } = client(() => ({ status: 200, body: SEARCH }), async () => { taken++; return true })
    expect((await qloo.search('Phoebe Bridgers', 'artist')).cached).toBe(false)
    expect((await qloo.search('Phoebe Bridgers', 'artist')).cached).toBe(true)
    expect(calls).toHaveLength(1)
    expect(taken).toBe(1)
  })

  it('makes no Qloo call when a daily cap is spent', async () => {
    const { qloo, calls } = client(() => ({ status: 200, body: SEARCH }), async () => false)
    await expect(qloo.search('Phoebe Bridgers', 'artist')).rejects.toThrow(/enough questions for today/)
    expect(calls).toHaveLength(0)
  })

  it("passes on Qloo's reason for a bad request, and treats 404 as no results", async () => {
    const bad = client(() => ({ status: 400, body: { errors: [{ message: 'All of the provided signal.interests.entities were invalid.' }] } }))
    await expect(bad.qloo.insights({ seedIds: ['nope'], type: 'brand' })).rejects.toThrow('Qloo said: All of the provided')
    expect(bad.cache.size()).toBe(0)
    const none = client(() => ({ status: 404, body: { code: 404, reason: 'No results' } }))
    expect((await none.qloo.search('zzqqxx', 'artist')).results).toEqual([])
  })

  it('finds tags by name and keeps only well formed tag ids', async () => {
    const { qloo, calls } = client(() => ({ status: 200, body: TAGS }))
    const { results } = await qloo.tags('Korean')
    expect(calls[0].url.pathname).toBe('/v2/tags')
    expect(calls[0].url.searchParams.get('filter.query')).toBe('Korean')
    expect(results).toEqual([{ id: 'urn:tag:cuisine:qloo:korean', name: 'Korean', kind: 'cuisine:qloo', for: ['place'] }])
  })

  it('sends tags as seeds and as filters, and no entity seed when there is none', async () => {
    const { qloo, calls } = client(() => ({ status: 200, body: INSIGHTS }))
    await qloo.insights({ seedIds: [], seedTags: ['urn:tag:cuisine:qloo:korean'], filterTags: ['urn:tag:genre:place:restaurant:korean'], type: 'place', location: 'Toronto' })
    const p = calls[0].url.searchParams
    expect(p.has('signal.interests.entities')).toBe(false)
    expect(p.get('signal.interests.tags')).toBe('urn:tag:cuisine:qloo:korean')
    expect(p.get('filter.tags')).toBe('urn:tag:genre:place:restaurant:korean')
  })

  it('with no key, answers from the cache and makes no Qloo call for anything else', async () => {
    const q = fakeQloo(() => ({ status: 200, body: SEARCH }))
    const cache = memoryCache()
    const keyed = new QlooClient(KEY, q.fetcher, cache, async () => true)
    await keyed.search('Phoebe Bridgers', 'artist')
    const keyless = new QlooClient('', q.fetcher, cache, async () => true)
    expect((await keyless.search('Phoebe Bridgers', 'artist')).cached).toBe(true)
    await expect(keyless.search('Khruangbin', 'artist')).rejects.toBeInstanceOf(QlooOff)
    expect(q.calls).toHaveLength(1)
  })
})

describe('the MCP tools', () => {
  function server(answer: (url: URL) => { status: number; body: unknown }) {
    const { qloo } = client(answer)
    return new McpServer<QlooContext>({
      info: { name: 'gift-scout', title: 'Gift Scout', version: '0' }, tools: qlooTools(), secret: 's', allowOrigin: () => false,
      context: async () => ({ qloo }),
    })
  }
  const post = (body: unknown, sid?: string) => new Request('https://x/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'MCP-Session-Id': sid } : {}) },
    body: JSON.stringify(body),
  })
  async function call(s: McpServer<QlooContext>, name: string, args: unknown) {
    const init = await s.handle(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } } }))
    const sid = init.headers.get('MCP-Session-Id')!
    const res = await s.handle(post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, sid))
    return (await res.json()) as { result: { content: { text: string }[]; structuredContent?: { results: { name: string }[] }; isError?: boolean } }
  }

  it('lists search_entities, search_tags and taste_insights', () => {
    expect(qlooTools().map((t) => t.name)).toEqual(['search_entities', 'search_tags', 'taste_insights'])
  })

  it('refuses a made up tag id before any Qloo call', async () => {
    let called = false
    const out = await call(server(() => { called = true; return { status: 200, body: INSIGHTS } }), 'taste_insights', { seed_tags: ['korean food'], target_type: 'place' })
    expect(out.result.isError).toBe(true)
    expect(called).toBe(false)
  })

  it('search_entities returns the entity and its id', async () => {
    const out = await call(server(() => ({ status: 200, body: SEARCH })), 'search_entities', { query: 'Phoebe Bridgers', type: 'artist' })
    expect(out.result.isError).toBeUndefined()
    expect(out.result.structuredContent!.results[0].name).toBe('Phoebe Bridgers')
    expect(out.result.content[0].text).toContain('id 00000000-0000-4000-8000-000000000001')
  })

  it('taste_insights returns names with their affinity', async () => {
    const out = await call(server(() => ({ status: 200, body: INSIGHTS })), 'taste_insights', { seed_ids: ['00000000-0000-4000'], target_type: 'brand' })
    expect(out.result.content[0].text).toContain('Fender (brand, affinity 0.93) id F1')
  })

  it('taste_insights exposes Qloo entity shares in its structured result', async () => {
    const answer = {
      results: { entities: [{ entity_id: 'F1', name: 'Fender', subtype: 'urn:entity:brand', query: {
        affinity: 0.93, explainability: { 'signal.interests.entities': [{ entity_id: 'SEED-001', score: 0.6 }, { entity_id: 'SEED-002', score: 0.4 }] },
      } }] },
    }
    const out = await call(server(() => ({ status: 200, body: answer })), 'taste_insights', { seed_ids: ['SEED-001', 'SEED-002'], target_type: 'brand' })
    expect(out.result.structuredContent!.results[0]).toMatchObject({ shares: [{ id: 'SEED-001', share: 0.6 }, { id: 'SEED-002', share: 0.4 }] })
  })

  it('refuses a type Qloo does not have, before any Qloo call', async () => {
    let called = false
    const out = await call(server(() => { called = true; return { status: 200, body: SEARCH } }), 'search_entities', { query: 'x', type: 'wine' })
    expect(out.result.isError).toBe(true)
    expect(called).toBe(false)
  })

  it('turns a Qloo error into a tool error that never holds the key', async () => {
    const out = await call(server(() => ({ status: 400, body: { errors: [{ message: 'All of the provided signal.interests.entities were invalid.' }] } })),
      'taste_insights', { seed_ids: ['nonsense-id'], target_type: 'brand' })
    expect(out.result.isError).toBe(true)
    expect(out.result.content[0].text).toContain('Qloo said:')
    expect(JSON.stringify(out)).not.toContain(KEY)
  })
})

describe('filter tags', () => {
  it('leaves out a filter tag made for another entity type, and keeps one for the target', async () => {
    const { otherTypeTag } = await import('../../src/qloo/tools')
    expect(otherTypeTag('urn:tag:genre:place:restaurant:korean', 'brand')).toBe(true)
    expect(otherTypeTag('urn:tag:genre:place:restaurant:korean', 'place')).toBe(false)
    expect(otherTypeTag('urn:tag:cuisine:qloo:korean', 'brand')).toBe(false)
  })
})

describe('finding the right seed', () => {
  it('matches a name to the name asked for, and not a book about it', async () => {
    const { nameMatches } = await import('../../src/qloo/tools')
    expect(nameMatches('John le Carré', 'Le Carre')).toBe(true)
    expect(nameMatches('Phoebe Bridgers', 'phoebe bridgers')).toBe(true)
    expect(nameMatches("Haruki Murakami's The Wind-up Bird Chronicle: A Reader's Guide (Continuum Contemporaries)", 'Haruki Murakami')).toBe(false)
    expect(nameMatches('Crossroads of Twilight (The Wheel of Time, #10)', 'Le Carre')).toBe(false)
  })

  it('asks again with no type when a typed search finds the wrong thing, and puts the true match first', async () => {
    const answer = (url: URL) => url.searchParams.has('types')
      ? { status: 200, body: { results: [{ entity_id: 'BOOK-1', name: 'Crossroads of Twilight (The Wheel of Time, #10)', types: ['urn:entity:book'] }] } }
      : { status: 200, body: { results: [{ entity_id: 'AUTH-1', name: 'John le Carré', types: ['urn:entity:author'] }] } }
    const { qloo, calls } = client(answer)
    const out = await searchEntities.run({ query: 'Le Carre', type: 'book' }, { qloo })
    expect(calls.map((c) => c.url.searchParams.get('types'))).toEqual(['urn:entity:book', null])
    const results = (out.structuredContent as { results: { id: string; type: string }[] }).results
    expect(results.map((r) => r.id)).toEqual(['AUTH-1'])
    expect(results[0].type).toBe('author')
  })

  it('keeps a typed answer when the untyped best match is not a person', async () => {
    const answer = (url: URL) => url.searchParams.has('types')
      ? { status: 200, body: { results: [{ entity_id: 'LAGA', name: 'Lagavulin', types: ['urn:entity:brand'] }] } }
      : { status: 200, body: { results: [{ entity_id: 'NOVEL', name: 'Single Malt Apocalypse', types: ['urn:entity:book'] }] } }
    const { qloo } = client(answer)
    const out = await searchEntities.run({ query: 'single malt', type: 'brand' }, { qloo })
    expect((out.structuredContent as { results: { id: string }[] }).results.map((r) => r.id)).toEqual(['LAGA'])
  })

  it('drops tags for one dish, which are never a taste', async () => {
    const { qloo } = client(() => ({ status: 200, body: { results: { tags: [
      { id: 'urn:tag:specialty_dish:place:single_malt_water_bottle', name: 'Single Malt Water Bottle', type: 'urn:tag:specialty_dish:place', parents: [] },
      { id: 'urn:tag:genre:brand:wine_and_spirits:spirits:whiskey:scotch', name: 'Scotch', type: 'urn:tag:genre:brand', parents: [{ type: 'urn:entity:brand' }] },
    ] } } }))
    expect((await qloo.tags('scotch')).results.map((t) => t.name)).toEqual(['Scotch'])
  })
})

describe('a cuisine searched as a name', () => {
  it('is answered with the cuisine tags, marked as tags', async () => {
    const { qloo, calls } = client(() => ({ status: 200, body: TAGS }))
    const out = await searchEntities.run({ query: 'Korean food' }, { qloo })
    expect(calls[0].url.pathname).toBe('/v2/tags')
    expect(calls[0].url.searchParams.get('filter.query')).toBe('Korean')
    expect(out.structuredContent).toMatchObject({ kind: 'tags', results: [{ id: 'urn:tag:cuisine:qloo:korean' }] })
  })
})

describe('audience signals', () => {
  it('sends age and gender as Qloo demographics signals, and nothing when not given', async () => {
    const { qloo, calls } = client(() => ({ status: 200, body: INSIGHTS }))
    await qloo.insights({ seedIds: ['A'], type: 'brand', age: '55_and_older', gender: 'male' })
    await qloo.insights({ seedIds: ['A'], type: 'book' })
    expect(calls[0].url.searchParams.get('signal.demographics.age')).toBe('55_and_older')
    expect(calls[0].url.searchParams.get('signal.demographics.gender')).toBe('male')
    expect(calls[1].url.searchParams.has('signal.demographics.age')).toBe(false)
    expect(calls[1].url.searchParams.has('signal.demographics.gender')).toBe(false)
  })

  it('uses separate cache entries for gendered and ungendered insights', async () => {
    const { qloo, calls, cache } = client(() => ({ status: 200, body: INSIGHTS }))
    await qloo.insights({ seedIds: ['A'], type: 'brand', gender: 'male' })
    await qloo.insights({ seedIds: ['A'], type: 'brand' })
    expect(calls).toHaveLength(2)
    expect(calls[0].url.searchParams.get('signal.demographics.gender')).toBe('male')
    expect(calls[1].url.searchParams.has('signal.demographics.gender')).toBe(false)
    expect(cache.size()).toBe(2)
  })
})
