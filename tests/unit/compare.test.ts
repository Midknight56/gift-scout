/// <reference types="@cloudflare/workers-types" />
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import worker, { type Env } from '../../src/worker'
import { newState } from '../../src/agent/agent'
import { runCompare } from '../../src/agent/compare'
import type { Model } from '../../src/agent/model'
import type { ScoutEvent } from '../../src/agent/events'
import { ownerToken } from '../../src/app/buy'
import { DEFAULT_ACCOUNT_NEURONS, DEFAULT_DAILY_NEURONS } from '../../src/limits'
import { Conversations, NeuronLedger } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const dbs: FakeD1[] = []
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const db of dbs.splice(0)) db.close()
})

const ideas = [
  { gift: 'A warm bottle', name: 'North Shore', kind: 'brand' },
  { gift: 'A novel', name: 'Quiet Harbor', kind: 'book' },
  { gift: 'A live show', name: 'Unknown Artist', kind: 'artist' },
]

function setup(opts: { take?: boolean; ai?: boolean; qloo?: boolean; reply?: unknown; scoreId?: string; beforeModel?: () => Promise<void> } = {}) {
  const db = new FakeD1(), ledger = new FakeD1()
  dbs.push(db, ledger)
  const id = 'compare1'
  const message = 'My aunt loves folk music and quiet weekends.'
  const state = { ...newState(id), turn: 1, said: [message], calls: 4, cards: [
    { id: 't1c1', gift: 'A record', why: 'She likes music.', price_low: 10, price_high: 20, entity: { id: 'CARD1', name: 'Card one', type: 'brand', affinity: 0.9 }, seeds: ['Folk artist'], from_call: 2 },
    { id: 't1c2', gift: 'A book', why: 'She likes quiet days.', price_low: 10, price_high: 20, entity: { id: 'CARD2', name: 'Card two', type: 'book', affinity: 0.7 }, seeds: ['Folk artist'], from_call: 3 },
  ] }
  const savedEvents: ScoutEvent[] = [
    { t: 'run', conversation: id, turn: 1, mode: 'live', said: message },
    { t: 'call', n: 1, tool: 'taste_insights', args: { seed_ids: ['SEED-ONE', 'SEED-TWO'], target_type: 'brand' } },
    { t: 'cards', cards: state.cards as never[], dropped: [] },
  ]
  const conversations = new Conversations(db)
  const write = conversations.put(id, state, [savedEvents])
  let modelCalls = 0, qlooCalls = 0, counterCalls = 0
  const qlooUrls: URL[] = []
  const ai = opts.ai === false ? undefined : { run: async (_model: string, input: unknown) => {
    modelCalls++
    await opts.beforeModel?.()
    const request = input as { messages: { role: string; content: string }[]; tools?: unknown[] }
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: message })
    expect(Object.hasOwn(request, 'tools')).toBe(false)
    return opts.reply ?? { response: JSON.stringify(ideas), usage: { prompt_tokens: 100, completion_tokens: 20 } }
  } }
  const env = {
    DB: db, LEDGER: ledger, SESSION_SECRET: 'test', AI: ai,
    QLOO_API_KEY: opts.qloo === false ? undefined : 'fake-qloo',
    COUNTERS: { idFromName: (name: string) => name, get: () => ({ take: async () => { counterCalls++; return opts.take ?? true } }) },
    ASSETS: { fetch: async () => new Response('page') },
  } as unknown as Env
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } } as unknown as ExecutionContext
  const pending: Promise<unknown>[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    qlooCalls++
    const url = new URL(String(input))
    qlooUrls.push(url)
    if (url.pathname === '/search') {
      const query = url.searchParams.get('query')!
      if (query === 'Unknown Artist') return new Response(JSON.stringify({ results: [] }), { status: 200 })
      const type = url.searchParams.get('types')!.replace('urn:entity:', '')
      const entityId = query === 'North Shore' ? 'PLAIN-BRAND' : 'PLAIN-BOOK'
      return new Response(JSON.stringify({ results: [{ entity_id: entityId, name: query, types: ['urn:entity:' + type] }] }), { status: 200 })
    }
    if (url.pathname === '/v2/insights') {
      expect(url.searchParams.get('signal.interests.entities')).toBe('SEED-ONE,SEED-TWO')
      const id = url.searchParams.get('filter.results.entities')!
      const affinity = id === 'PLAIN-BRAND' ? 0.8 : 0.6
      const type = url.searchParams.get('filter.type')!.replace('urn:entity:', '')
      return new Response(JSON.stringify({ results: { entities: [{ entity_id: opts.scoreId ?? id, name: id === 'PLAIN-BRAND' ? 'North Shore' : 'Quiet Harbor', subtype: 'urn:entity:' + type, query: { affinity } }] } }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { db, ledger, id, env, ctx, pending, qlooUrls, get modelCalls() { return modelCalls }, get qlooCalls() { return qlooCalls }, get counterCalls() { return counterCalls }, ready: write }
}

async function request(h: ReturnType<typeof setup>, owner?: string) {
  await h.ready
  const response = await worker.fetch(new Request('https://gift.test/api/compare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: h.id, owner }),
  }), h.env, h.ctx)
  const raw = await response.text()
  await Promise.all(h.pending)
  return { response, events: raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) }
}

describe('POST /api/compare', () => {
  it('reserves budget before concurrent comparisons call the model', async () => {
    const db = new FakeD1(); dbs.push(db)
    const ledger = new NeuronLedger(db, { app: 'gift-scout', dailyCap: 50, accountCap: 50, reserve: 50, day: () => '2026-10-23' })
    let modelCalls = 0, releaseModel!: () => void
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
    const model: Model = { name: 'shared', async chat() {
      modelCalls++
      await modelGate
      return { content: 'No ideas', tool_calls: [], prompt_tokens: 1, completion_tokens: 1 }
    } }
    const options = { message: 'compare these', seedIds: [], cards: [], qloo: {} as never, model, budget: ledger, emit: async () => {} }
    const first = runCompare(options)
    const second = runCompare(options)
    releaseModel()
    await Promise.all([first, second])
    expect(modelCalls).toBe(1)
    expect((await ledger.spentToday()).all).toBeLessThanOrEqual(50)
  })

  it('scores found ideas and marks a missing idea without a score', async () => {
    const h = setup()
    const { events } = await request(h, await ownerToken(h.id, 'test'))
    expect(events[0]).toMatchObject({ t: 'run', purpose: 'compare', mode: 'live' })
    expect(events.filter((event) => event.t === 'call')).toHaveLength(5)
    expect(events.filter((event) => event.t === 'call' && event.tool === 'taste_insights')).toHaveLength(2)
    expect(events.find((event) => event.t === 'call' && event.tool === 'taste_insights')).toMatchObject({ args: { audience_gender: 'female' } })
    expect(h.qlooUrls.filter((url) => url.pathname === '/v2/insights').every((url) => url.searchParams.get('signal.demographics.gender') === 'female')).toBe(true)
    const result = events.find((event) => event.t === 'compare')!
    expect(result).toMatchObject({ plain_mean: 0.7, qloo_mean: 0.8, not_found: 1 })
    expect(result.plain).toEqual([
      { ...ideas[0], found: true, affinity: 0.8 },
      { ...ideas[1], found: true, affinity: 0.6 },
      { ...ideas[2], found: false },
    ])
    expect(events.map((event) => event.t)).toEqual(['run', 'call', 'result', 'call', 'result', 'call', 'result', 'call', 'result', 'call', 'result', 'compare', 'usage', 'done'])
    const usage = await h.ledger.prepare('SELECT neurons FROM ai_calls').bind().first<{ neurons: number }>()
    expect(usage?.neurons).toBeCloseTo(1.072)
  })

  it('ends with done and saves the compare event as a conversation turn', async () => {
    const h = setup()
    const { events } = await request(h, await ownerToken(h.id, 'test'))
    expect(events.at(-1)).toMatchObject({ t: 'done', share: '/s/' + h.id })
    const saved = await new Conversations(h.db).get(h.id)
    expect(saved?.turns.at(-1)?.some((event) => event.t === 'compare')).toBe(true)
    expect(saved?.state.calls).toBe(9)
  })

  it('returns one plain error for a model reply that is not the requested JSON', async () => {
    const h = setup({ reply: { response: 'Here are some lovely ideas.', usage: { prompt_tokens: 10, completion_tokens: 10 } } })
    const { events } = await request(h, await ownerToken(h.id, 'test'))
    expect(events.filter((event) => event.t === 'error')).toEqual([{ t: 'error', text: 'The model did not give gift ideas in the right shape.' }])
    expect(events.at(-1)).toMatchObject({ t: 'done' })
    expect(h.qlooCalls).toBe(0)
  })

  it('does not use an affinity for a different Qloo entity', async () => {
    const h = setup({ reply: { response: JSON.stringify([ideas[0]]), usage: { prompt_tokens: 10, completion_tokens: 10 } }, scoreId: 'SOME-OTHER-ENTITY' })
    const { events } = await request(h, await ownerToken(h.id, 'test'))
    const result = events.find((event) => event.t === 'compare')!
    expect(result.plain).toEqual([{ ...ideas[0], found: false }])
    expect(result.plain_mean).toBeNull()
  })

  it.each([undefined, 'wrong-token'])('rejects a missing or wrong owner token before work', async (owner) => {
    const h = setup()
    const { response } = await request(h, owner)
    expect(response.status).toBe(403)
    expect(h.modelCalls).toBe(0)
    expect(h.qlooCalls).toBe(0)
    expect(h.counterCalls).toBe(0)
  })

  it('stops at the visitor compare cap before the model call', async () => {
    const h = setup({ take: false })
    const { events } = await request(h, await ownerToken(h.id, 'test'))
    expect(h.modelCalls).toBe(0)
    expect(h.qlooCalls).toBe(0)
    expect(events.some((event) => event.t === 'error')).toBe(true)
  })

  it('rejects an already compared conversation without a model call or visitor cap', async () => {
    const h = setup()
    await h.ready
    const saved = await new Conversations(h.db).get(h.id)
    await new Conversations(h.db).put(h.id, saved!.state, [...saved!.turns, [
      { t: 'run', conversation: h.id, turn: 2, mode: 'live', said: 'compare', purpose: 'compare' },
      { t: 'compare', plain: [], plain_mean: null, qloo_mean: 0.9, not_found: 0 },
    ]])
    const { events } = await request(h, await ownerToken(h.id, 'test'))
    expect(events).toEqual([
      { t: 'error', text: 'This conversation was already compared.' },
      { t: 'done', share: '/s/' + h.id },
    ])
    expect(h.modelCalls).toBe(0)
    expect(h.qlooCalls).toBe(0)
    expect(h.counterCalls).toBe(0)
  })

  it('serializes simultaneous compares and saves only one compare turn', async () => {
    let enterModel!: () => void
    let releaseModel!: () => void
    const modelEntered = new Promise<void>((resolve) => { enterModel = resolve })
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
    const h = setup({ beforeModel: async () => { enterModel(); await modelGate } })
    const owner = await ownerToken(h.id, 'test')
    const first = request(h, owner)
    await modelEntered
    const second = request(h, owner)
    releaseModel()
    const [a, b] = await Promise.all([first, second])
    expect(h.modelCalls).toBe(1)
    const results = [a, b]
    expect(results.filter(({ events }) => events.some((event) => event.t === 'error' && event.text === 'This conversation was already compared.'))).toHaveLength(1)
    expect(results.filter(({ events }) => events.some((event) => event.t === 'compare'))).toHaveLength(1)
    const saved = await new Conversations(h.db).get(h.id)
    expect(saved?.turns.filter((turn) => turn.some((event) => event.t === 'run' && event.purpose === 'compare'))).toHaveLength(1)
  })

  it('asks the neuron budget before calling the model', async () => {
    const h = setup()
    h.ledger.insertCall('gift-scout', new Date().toISOString().slice(0, 10), DEFAULT_DAILY_NEURONS)
    h.ledger.insertCall('other-app', new Date().toISOString().slice(0, 10), DEFAULT_ACCOUNT_NEURONS)
    const { events } = await request(h, await ownerToken(h.id, 'test'))
    expect(h.modelCalls).toBe(0)
    expect(h.qlooCalls).toBe(0)
    expect(events.some((event) => event.t === 'error')).toBe(true)
  })

  it.each([{ ai: false }, { qloo: false }])('needs live scouting when a live service is absent', async (missing) => {
    const h = setup(missing)
    const { events } = await request(h, await ownerToken(h.id, 'test'))
    expect(events).toMatchObject([
      { t: 'run', mode: 'off', purpose: 'compare' },
      { t: 'error', text: 'Comparing needs live scouting, which is off right now.' },
      { t: 'done' },
    ])
  })
})

describe('reading the plain model reply', () => {
  it('reads an array wrapped in a code fence or a sentence, and ignores extra fields', async () => {
    const { parsePlainIdeas } = await import('../../src/agent/compare')
    const fenced = 'Here you go:\n```json\n[{"gift":"A bottle of Johnnie Walker","name":"Johnnie Walker","kind":"brand","note":"classic"}]\n```'
    expect(parsePlainIdeas(fenced)).toEqual([{ gift: 'A bottle of Johnnie Walker', name: 'Johnnie Walker', kind: 'brand' }])
    expect(parsePlainIdeas('no ideas today')).toBeNull()
    expect(parsePlainIdeas('[{"gift":"x","name":"y","kind":"car"}]')).toBeNull()
  })

  it('keeps valid rows, maps author to book, and skips invalid rows', async () => {
    const { parsePlainIdeas } = await import('../../src/agent/compare')
    expect(parsePlainIdeas(JSON.stringify([
      { gift: 'A Le Carre novel', name: 'John le Carre', kind: 'author' },
      { gift: '', name: 'Missing gift', kind: 'brand' },
      { gift: 'A mystery gift', name: 'Unknown thing', kind: 'car' },
      { gift: 'A bottle', name: 'North Shore', kind: 'brand' },
    ]))).toEqual([
      { gift: 'A Le Carre novel', name: 'John le Carre', kind: 'book' },
      { gift: 'A bottle', name: 'North Shore', kind: 'brand' },
    ])
  })

  it('returns null when every plain idea row is invalid', async () => {
    const { parsePlainIdeas } = await import('../../src/agent/compare')
    expect(parsePlainIdeas(JSON.stringify([
      { gift: '', name: 'No gift', kind: 'brand' },
      { gift: 'A car', name: 'A car', kind: 'car' },
    ]))).toBeNull()
  })
})

describe('buy button selectors in browser tools', () => {
  it('targets the actual buy data attribute in e2e, film, and phone flows', async () => {
    const { readFile } = await import('node:fs/promises')
    for (const file of ['tools/e2e.mjs', 'tools/film.mjs', 'tools/phones.mjs']) {
      const source = await readFile(new URL('../../' + file, import.meta.url), 'utf8')
      expect(source).toMatch(/locator\([^)]*\[data-buy\]/)
      expect(source).not.toMatch(/locator\([^)]*\.buy-button/)
    }
  })
})

describe('a failed comparison', () => {
  it('does not block a later comparison of the same conversation', async () => {
    const { compareTurn } = await import('../../src/app/compare')
    const db = new FakeD1(); const conversations = new Conversations(db)
    const state = newState('conv-failed'); state.said = ['My dad. Le Carre novels and single malt.']
    const cards: ScoutEvent = { t: 'cards', cards: [{ id: 't1c1', gift: 'A bottle', why: 'Smoky.', price_low: 20, price_high: 40, entity: { id: 'E1', name: 'Laphroaig', type: 'brand', affinity: 0.9 }, seeds: ['Lagavulin'], from_call: 1 }], dropped: [] }
    await conversations.put('conv-failed', state, [[cards], [{ t: 'run', conversation: 'conv-failed', turn: 1, mode: 'off', purpose: 'compare' }, { t: 'error', text: 'Comparing needs live scouting, which is off right now.' }]])
    const events: ScoutEvent[] = []
    await compareTurn('conv-failed', { conversations, live: null }, async (e) => { events.push(e) })
    expect(events.some((e) => e.t === 'error' && e.text === 'This conversation was already compared.')).toBe(false)
    db.close()
  })
})
