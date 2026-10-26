import { describe, expect, it } from 'vitest'
import { checkCards, flattenIdeas, MAX_MODEL_CALLS, newState, pickProduct, plain, productQuery, runTurn, saidIn, type Budget, type ConversationState } from '../../src/agent/agent'
import type { ScoutEvent } from '../../src/agent/events'
import { neuronsFor, readReply, stripThinking, WorkersAiModel, type ChatMessage, type Model, type ModelReply, type ToolCall } from '../../src/agent/model'
import { QlooClient, type Cache } from '../../src/qloo/client'
import { qlooTools } from '../../src/qloo/tools'

const PB = '00000000-0000-4000-8000-000000000001'
const KOREAN = 'urn:tag:genre:place:restaurant:korean'
const SISTER = 'My sister. She loves Phoebe Bridgers and Korean food. She lives in Toronto. Under 60 dollars.'
const LIVE_BARE_CALL = "{\"name\": \"present_gifts\", \"arguments\": {\"ideas\": {\"brand\": [{\"entity_id\": \"00000000-0000-4000-8000-000000000002\", \"gift\": \"A Marc Jacobs scarf\", \"why\": \"A stylish accessory that matches his love for Taylor Swift's fashion sense.\", \"price_low\": 30, \"price_high\": 50}, {\"entity_id\": \"00000000-0000-4000-8000-000000000007\", \"gift\": \"A pair of Christian Louboutin socks\", \"why\": \"A fun and fashionable twist on his baking hobby.\", \"price_low\": 20, \"price_high\": 40}], \"book\": [{\"entity_id\": \"00000000-0000-4000-8000-000000000003\", \"gift\": \"A copy of Where the Grass Is Green and the Girls Are Pretty\", \"why\": \"A book that captures the essence of Taylor Swift's storytelling.\", \"price_low\": 15, \"price_high\": 25}], \"podcast\": [{\"entity_id\": \"00000000-0000-4000-8000-000000000004\", \"gift\": \"A subscription to For Crying Out Loud\", \"why\": \"A podcast that matches his love for Taylor Swift's candid style.\", \"price_low\": 10, \"price_high\": 20}, {\"entity_id\": \"00000000-0000-4000-8000-000000000005\", \"gift\": \"A Baking it Down with Sugar Cookie Marketing podcast episode\", \"why\": \"A fun and informative podcast that combines his love for baking and Taylor Swift.\", \"price_low\": 10, \"price_high\": 20}], \"destination\": [{\"entity_id\": \"00000000-0000-4000-8000-000000000006\", \"gift\": \"A Bali travel guide\", \"why\": \"A beautiful destination that matches his love for Taylor Swift's music.\", \"price_low\": 10, \"price_high\": 20}]}}"

// Qloo's answers, shaped as measured on 22 and 23 Oct 2026 (trimmed). Each kind of gift has its own entities.
function qlooAnswer(url: URL): unknown {
  if (url.pathname === '/search') return { results: [{ entity_id: PB, name: 'Phoebe Bridgers', types: ['urn:entity:artist'] }] }
  if (url.pathname === '/v2/tags') {
    return { results: { tags: [
      { id: 'urn:tag:genre:music:korean', name: 'Korean', type: 'urn:tag:genre:music', parents: [{ type: 'urn:entity:artist' }] },
      { id: KOREAN, name: 'Korean', type: 'urn:tag:genre:place', parents: [{ type: 'urn:entity:place' }] },
    ] } }
  }
  const type = (url.searchParams.get('filter.type') ?? '').replace('urn:entity:', '')
  const one = (id: string, name: string, affinity: number) => ({ entity_id: id, name, subtype: 'urn:entity:' + type, query: {
    affinity, explainability: { 'signal.interests.entities': [{ entity_id: PB, score: 0.56 }, { entity_id: 'UNKNOWN-SEED', score: 0.44 }] },
  } })
  const by: Record<string, unknown[]> = {
    brand: [one('B-FENDER', 'Fender', 0.9307), one('B-HMART', 'H MART', 0.8818), one('B-VANS', 'Vans', 0.88)],
    book: [one('K-HOMESICK', 'Homesick', 0.886)],
    podcast: [one('P-SONG', 'Song Exploder', 0.861)],
    destination: [one('D-SEOUL', 'Seoul', 0.9)],
    place: [one('L-NAMOO', 'Cafe Namoo Toronto', 0.8149)],
  }
  return { results: { entities: by[type] ?? [] } }
}

function qloo() {
  const asked: URL[] = []
  const m = new Map<string, string>()
  const cache: Cache = { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } }
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    asked.push(url)
    return new Response(JSON.stringify(qlooAnswer(url)), { status: 200 })
  }) as typeof fetch
  return { ctx: { qloo: new QlooClient('k', fetcher, cache, async () => true) }, asked }
}

let callId = 0
function call(name: string, args: unknown): ToolCall {
  return { id: 'c' + ++callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
function reply(calls: ToolCall[], content = ''): ModelReply {
  return { content, tool_calls: calls, prompt_tokens: 1000, completion_tokens: 100, cut: false }
}

/** A model that gives set replies in order, and keeps what it was sent and which tools it was offered. */
function scripted(replies: ModelReply[]): Model & { seen: ChatMessage[][]; offered: string[][] } {
  const seen: ChatMessage[][] = []
  const offered: string[][] = []
  return {
    name: 'scripted', seen, offered,
    async chat(messages, tools) {
      seen.push(structuredClone(messages))
      offered.push(tools.map((t) => t.function.name))
      const r = replies.shift(); if (!r) throw new Error('no more replies'); return r
    },
  }
}

function budget(allowed = true): Budget & { spent: number[] } {
  const spent: number[] = []
  return { spent, allow: async () => allowed, reserve: async () => allowed ? { settle: async (n) => { spent.push(n) } } : null }
}

const PLAN = { loves: [{ name: 'Phoebe Bridgers', kind: 'named' }, { name: 'Korean food', kind: 'cuisine' }], city: 'Toronto', budget_max: 60 }
const card = (entity_id: string, gift: string, low = 20, high = 40) => ({ entity_id, gift, why: 'A good fit for her.', price_low: low, price_high: high })

async function turn(model: Model, message = SISTER, state = newState('conv1'), b = budget()) {
  const events: ScoutEvent[] = []
  const { ctx, asked } = qloo()
  const next = await runTurn({ message, state, model, tools: qlooTools(), ctx, budget: b, emit: (e) => { events.push(e) } })
  return { events, state: next, asked }
}

/** A conversation one turn in, so the next turn is a later turn with the free tool loop. */
function laterState(): ConversationState {
  return { ...newState('conv1'), turn: 1, said: [SISTER], names: { [PB]: 'Phoebe Bridgers' } }
}

const CUT_KINDS = ['book', 'brand', 'place', 'destination', 'podcast'] as const
const cutoffId = (index: number) => `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}${'a'.repeat(28)}`

function cutoffState(): ConversationState {
  const state = laterState()
  for (const [kindIndex, kind] of CUT_KINDS.entries()) {
    for (let idea = 0; idea < 2; idea++) {
      const id = cutoffId(kindIndex * 2 + idea)
      state.found[id] = { entity: { id, name: `${kind} ${idea}`, type: kind }, seeds: [], from_call: 1 }
    }
  }
  return state
}

function cutoffAnswer(short: boolean, verbose = false): string {
  const ideas = Object.fromEntries(CUT_KINDS.map((kind, kindIndex) => [kind, Array.from({ length: short ? 1 : 2 }, (_, idea) => ({
    entity_id: cutoffId(kindIndex * 2 + idea),
    gift: verbose ? `A thoughtful ${kind} gift ${idea} chosen especially for her personal interests` : `A thoughtful ${kind} gift ${idea}`,
    why: short ? 'A good fit for her.' : verbose
      ? 'A thoughtful choice for her, with a personal detail that connects naturally to the interests she shared and makes this present feel considered. This gift reflects her favorite things and feels personal.'
      : 'A thoughtful choice for her, with a personal detail that connects naturally to the interests she shared and makes this present feel considered.',
    price_low: 20,
    price_high: 40,
  }))]))
  return JSON.stringify({ name: 'present_gifts', arguments: { ideas } })
}

function cutModel(fullAnswerLength = 3300): Model & { seen: ChatMessage[][]; maxTokens: number[] } {
  const seen: ChatMessage[][] = []
  const maxTokens: number[] = []
  return {
    name: 'cutoff', seen, maxTokens,
    async chat(messages, _tools, cap) {
      seen.push(structuredClone(messages))
      maxTokens.push(cap)
      const short = messages.some((message) => message.role === 'user' && message.content.includes('at most six ideas'))
      let answer = cutoffAnswer(short, fullAnswerLength > 3600)
      if (!short && answer.length < fullAnswerLength) answer = answer.slice(0, -1) + ' '.repeat(fullAnswerLength - answer.length) + '}'
      const text = answer.slice(0, Math.floor(cap * 2.6))
      const cut = answer.length > cap * 2.6
      return readReply({ choices: [{ finish_reason: cut ? 'length' : 'stop', message: { content: text, tool_calls: [] } }], usage: { prompt_tokens: 1000, completion_tokens: cut ? cap : Math.floor(answer.length / 2.6) }, }, ['present_gifts'])
    },
  }
}

describe('cut present_gifts answers', () => {
  it('raises the output cap enough for a full bare answer', async () => {
    const model = cutModel(3300)
    const { events, state } = await turn(model, 'My partner. She loves Frida Kahlo and Mexican food. We live in Montreal. Anniversary.', cutoffState())
    expect(state.cards.length).toBeGreaterThanOrEqual(5)
    expect(events.some((event) => event.t === 'error')).toBe(false)
  })

  it('retries an oversized cut answer once with a short request', async () => {
    const model = cutModel(5000)
    const { events, state } = await turn(model, 'My partner. She loves Frida Kahlo and Mexican food. We live in Montreal. Anniversary.', cutoffState())
    expect(state.cards.length).toBeGreaterThanOrEqual(5)
    expect(model.seen.filter((messages) => messages.some((message) => message.role === 'user' && message.content.includes('at most six ideas')))).toHaveLength(1)
    expect(model.seen.length).toBeLessThanOrEqual(MAX_MODEL_CALLS)
    expect(events.some((event) => event.t === 'error')).toBe(false)
  })
})

describe('a first turn: plan, then present', () => {
  it('corrects a card why from the first message pronoun', async () => {
    const model = scripted([
      reply([call('plan_scout', { loves: [{ name: 'Phoebe Bridgers', kind: 'named' }] })]),
      reply([call('present_gifts', { cards: [{ ...card('B-FENDER', 'A Fender strap'), why: "A stylish addition that matches her love for Taylor Swift's fashion sense." }] })]),
      reply([call('present_gifts', { cards: [{ ...card('B-FENDER', 'A Fender strap'), why: "A stylish addition that matches her love for Taylor Swift's fashion sense." }] })]),
    ])
    const { events } = await turn(model, 'My brother. He loves Phoebe Bridgers.')
    const cards = events.find((e) => e.t === 'cards') as Extract<ScoutEvent, { t: 'cards' }>
    expect(cards.cards[0].why).toBe("A stylish addition that matches his love for Taylor Swift's fashion sense.")
    expect(model.seen[0][0].content).toContain('The person is male: use he, him and his.')
  })

  it('turns the plan into one search per love and one insights call per kind, then keeps only grounded cards', async () => {
    const model = scripted([
      reply([call('plan_scout', PLAN)]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap'), card('L-NAMOO', 'Dinner at Cafe Namoo'), card('MADE-UP-ID-123', 'A Gucci bag')] })]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap'), card('L-NAMOO', 'Dinner at Cafe Namoo'), card('MADE-UP-ID-123', 'A Gucci bag')] })]),
    ])
    const { events, state, asked } = await turn(model)
    expect(model.offered).toEqual([['plan_scout'], ['present_gifts'], ['present_gifts']])
    // Two searches (the artist, then the cuisine as tags), then brand, book, podcast, destination and place.
    expect(asked.map((u) => u.pathname)).toEqual(['/search', '/v2/tags', '/v2/insights', '/v2/insights', '/v2/insights', '/v2/insights', '/v2/insights'])
    const insights = asked.filter((u) => u.pathname === '/v2/insights')
    expect(insights.map((u) => u.searchParams.get('filter.type'))).toEqual(['urn:entity:brand', 'urn:entity:book', 'urn:entity:podcast', 'urn:entity:destination', 'urn:entity:place'])
    for (const u of insights) {
      expect(u.searchParams.get('signal.interests.entities')).toBe(PB)
      expect(u.searchParams.get('signal.interests.tags')).toBe(KOREAN)
    }
    const place = insights[4].searchParams
    expect(place.get('filter.location.query')).toBe('Toronto')
    expect(place.get('filter.tags')).toBe(KOREAN)
    expect(events.filter((e) => e.t === 'call')).toHaveLength(7)
    const cards = events.find((e) => e.t === 'cards') as Extract<ScoutEvent, { t: 'cards' }>
    expect(cards.cards.map((c) => c.entity.name)).toEqual(['Fender', 'Cafe Namoo Toronto'])
    expect(cards.dropped).toEqual([{ gift: 'A Gucci bag', reason: 'no Qloo result behind it' }])
    // The affinity and the seeds come from the tool result, by code.
    expect(cards.cards[0]).toMatchObject({ id: 't1c1', from_call: 3, seeds: ['Phoebe Bridgers', 'Korean'], entity: { affinity: 0.931 } })
    expect(cards.cards[0].seed_shares).toEqual([{ name: 'Phoebe Bridgers', share: 0.56 }])
    expect(cards.cards[0].tag_seeds).toEqual(['Korean'])
    expect(model.seen[1].at(-1)?.content).toContain('Fender (brand, affinity 0.93, mostly from Phoebe Bridgers 56%) id B-FENDER')
    expect(model.seen[1].at(-1)?.content).not.toContain('UNKNOWN-SEED')
    expect(state).toMatchObject({ turn: 1, calls: 7, budget_max: 60 })
  })

  it('uses bucketed ideas to keep results across the available kinds', async () => {
    const model = scripted([
      reply([call('plan_scout', PLAN)]),
      reply([call('present_gifts', { ideas: {
        brand: [card('B-FENDER', 'A Fender strap')], book: [card('K-HOMESICK', 'A copy of Homesick')],
        podcast: [card('P-SONG', 'Song Exploder merch')], destination: [card('D-SEOUL', 'A trip to Seoul')],
        place: [card('L-NAMOO', 'Dinner at Cafe Namoo')],
      } })]),
    ])
    const { events } = await turn(model)
    const cards = events.find((e) => e.t === 'cards') as Extract<ScoutEvent, { t: 'cards' }>
    expect(new Set(cards.cards.map((c) => c.entity.type)).size).toBeGreaterThanOrEqual(4)
  })

  it('reads a bare present call in runTurn and does not say its JSON', async () => {
    const bare = JSON.stringify({ name: 'present_gifts', arguments: { ideas: {
      brand: [card('B-FENDER', 'A Fender strap')], book: [card('K-HOMESICK', 'A copy of Homesick')],
      podcast: [card('P-SONG', 'Song Exploder merch')], destination: [card('D-SEOUL', 'A trip to Seoul')],
      place: [card('L-NAMOO', 'Dinner at Cafe Namoo')],
    } } })
    let calls = 0
    const model: Model = { name: 'bare reply', async chat(_messages, tools) {
      if (calls++ === 0) return reply([call('plan_scout', PLAN)])
      return readReply({ choices: [{ message: { content: bare, tool_calls: [] } }] }, tools.map((tool) => tool.function.name))
    } }
    const { events } = await turn(model)
    expect(events.find((e) => e.t === 'cards')).toBeDefined()
    expect(events.filter((e) => e.t === 'say').every((e) => e.t !== 'say' || !e.text.includes(bare))).toBe(true)
  })

  it('leaves out a city they never named, and asks no place', async () => {
    const model = scripted([
      reply([call('plan_scout', { loves: [{ name: 'Phoebe Bridgers', kind: 'named' }], city: 'New York' })]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]),
    ])
    const { asked } = await turn(model, 'My dad loves Phoebe Bridgers.')
    expect(asked.some((u) => u.searchParams.get('filter.type') === 'urn:entity:place')).toBe(false)
  })

  it("holds the plan's budget when the cards leave it out", async () => {
    const model = scripted([
      reply([call('plan_scout', PLAN)]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender guitar', 300, 900), card('B-HMART', 'An H MART basket')] })]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender guitar', 300, 900), card('B-HMART', 'An H MART basket')] })]),
    ])
    const { events } = await turn(model)
    const cards = events.find((e) => e.t === 'cards') as Extract<ScoutEvent, { t: 'cards' }>
    expect(cards.dropped).toEqual([{ gift: 'A Fender guitar', reason: 'over the budget' }])
  })

  it('reminds the model once when it writes prose instead of planning', async () => {
    const model = scripted([
      reply([], 'What a lovely sister!'),
      reply([call('plan_scout', PLAN)]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]),
    ])
    const { events } = await turn(model)
    expect(model.seen[1].at(-1)).toMatchObject({ role: 'user', content: expect.stringMatching(/^First call plan_scout/) })
    expect(events.filter((e) => e.t === 'cards')).toHaveLength(1)
  })

  it('counts neurons from every model call', async () => {
    const model = scripted([reply([call('plan_scout', PLAN)]), reply([], 'Hmm.'), reply([], 'Still hmm.')])
    const b = budget()
    const { events } = await turn(model, SISTER, newState('conv1'), b)
    const usage = events.find((e) => e.t === 'usage') as Extract<ScoutEvent, { t: 'usage' }>
    expect(b.spent).toHaveLength(3)
    expect(usage).toMatchObject({ model_calls: 3, neurons: Math.round(3 * neuronsFor(1000, 100) * 10) / 10 })
  })

  it('makes no model call when the budget is spent, and says so calmly', async () => {
    const model = scripted([])
    const { events } = await turn(model, SISTER, newState('conv1'), budget(false))
    expect(model.seen).toHaveLength(0)
    expect(events[0]).toMatchObject({ t: 'error', text: expect.stringMatching(/budget for today/) })
  })

  it('does not run a tool the step does not offer, nor a repeated plan', async () => {
    const model = scripted([
      reply([call('taste_insights', { seed_ids: [PB], target_type: 'brand' }), call('plan_scout', PLAN), call('plan_scout', PLAN)]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]),
    ])
    const { asked, events } = await turn(model)
    expect(asked.filter((u) => u.pathname === '/v2/insights')).toHaveLength(5)
    expect(model.seen[1].filter((m) => m.role === 'tool').map((m) => m.content.split(/\s/)[0])).toEqual(['Not', 'BRAND:', 'You'])
    expect(events.filter((e) => e.t === 'cards')).toHaveLength(1)
  })

  it('stops after the model call limit', async () => {
    const model = scripted(Array.from({ length: MAX_MODEL_CALLS + 2 }, () => reply([call('plan_scout', { loves: [] })])))
    const { events } = await turn(model)
    expect(model.seen).toHaveLength(MAX_MODEL_CALLS)
    expect(events.some((e) => e.t === 'error')).toBe(true)
  })
})

describe('a later turn: the free tool loop', () => {
  it('starts from the earlier results in short form, may ask Qloo again, and presents', async () => {
    const st = laterState()
    st.found['B-HMART'] = { entity: { id: 'B-HMART', name: 'H MART', type: 'brand', affinity: 0.88 }, seeds: ['Phoebe Bridgers', 'Korean'], from_call: 3 }
    const model = scripted([
      reply([call('taste_insights', { seed_ids: [PB], target_type: 'book' })]),
      reply([call('present_gifts', { cards: [card('B-HMART', 'An H MART gift card', 20, 30), card('K-HOMESICK', 'A copy of Homesick', 15, 25)], budget_max: 30 })]),
    ])
    const { events, state } = await turn(model, 'Cheaper please', st)
    expect(model.offered[0]).toEqual(['search_entities', 'search_tags', 'taste_insights', 'present_gifts'])
    const sent = model.seen[0][1].content
    expect(sent).toContain('Their new message: Cheaper please')
    expect(sent).toContain('H MART (affinity 0.88) [brand] id B-HMART')
    expect(events.find((e) => e.t === 'call')).toMatchObject({ n: 1, tool: 'taste_insights' })
    expect(state.cards.map((c) => c.id)).toEqual(['t2c1', 't2c2'])
    expect(state.budget_max).toBe(30)
  })

  it('takes a city they never named out of a call', async () => {
    const model = scripted([
      reply([call('taste_insights', { seed_ids: [PB], target_type: 'place', location: 'New York' })]),
      reply([call('present_gifts', { cards: [card('L-NAMOO', 'Dinner')] })]),
    ])
    const { asked, events } = await turn(model, 'Somewhere to eat?', laterState())
    expect(asked[0].searchParams.has('filter.location.query')).toBe(false)
    expect(events.find((e) => e.t === 'call')).toMatchObject({ args: { seed_ids: [PB], target_type: 'place' } })
  })

  it('does not ask the same question twice, and then must present', async () => {
    const ask = () => call('taste_insights', { seed_ids: [PB], target_type: 'brand' })
    const model = scripted([
      reply([ask()]),
      reply([ask()]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]),
    ])
    const { asked } = await turn(model, 'More brands', laterState())
    expect(asked).toHaveLength(1)
    expect(model.offered[2]).toEqual(['present_gifts'])
  })

  it('asks once more when the kind cap drops cards, before showing anything', async () => {
    const st = laterState()
    for (const id of ['A', 'B', 'C']) st.found[id] = { entity: { id, name: id, type: 'podcast' }, seeds: ['Phoebe Bridgers'], from_call: 1 }
    st.found.D = { entity: { id: 'D', name: 'D', type: 'book' }, seeds: ['Phoebe Bridgers'], from_call: 2 }
    const model = scripted([
      reply([call('present_gifts', { cards: ['A', 'B', 'C'].map((id) => card(id, 'Merch of ' + id)) })]),
      reply([call('present_gifts', { cards: ['A', 'B', 'D'].map((id) => card(id, 'Merch of ' + id)) })]),
    ])
    const { events, state } = await turn(model, 'again', st)
    expect(model.seen[1].at(-1)).toMatchObject({ role: 'tool', content: expect.stringMatching(/^Only 2 kept\. Qloo also gave book results \(D\): add one idea for each\./) })
    expect(events.filter((e) => e.t === 'cards')).toHaveLength(1)
    expect(state.cards.map((c) => c.entity.id)).toEqual(['A', 'B', 'D'])
  })

  it('explains over-budget drops, shows cheaper examples for unused kinds, then accepts affordable cards', async () => {
    const st = laterState()
    st.budget_max = 60
    st.found = {
      V: { entity: { id: 'V', name: 'Victoria', type: 'destination' }, seeds: [], from_call: 1 },
      P: { entity: { id: 'P', name: 'The Ben and Ashley I Almost Famous Podcast', type: 'podcast' }, seeds: [], from_call: 1 },
      B: { entity: { id: 'B', name: 'Everything Beautiful in Its Time', type: 'book' }, seeds: [], from_call: 1 },
      D: { entity: { id: 'D', name: 'Diane Von Furstenberg', type: 'brand' }, seeds: [], from_call: 1 },
    }
    const model = scripted([
      reply([call('present_gifts', { cards: [card('D', 'A dress', 90, 140), card('V', 'A trip to Victoria', 100, 300)] })]),
      reply([call('present_gifts', { cards: [card('D', 'A small scarf', 30, 50), card('V', 'A day trip to Victoria', 40, 60), card('P', 'Merch from the podcast', 20, 40), card('B', 'A copy of the book', 15, 25)] })]),
    ])
    const { events, state } = await turn(model, 'My brother. Birthday, under 60 dollars.', st)
    const feedback = model.seen[1].at(-1)?.content ?? ''
    expect(feedback).toContain('Each idea must start at or under $60.')
    expect(feedback).toContain('a copy of Everything Beautiful in Its Time')
    expect(feedback).toContain('merch from The Ben and Ashley I Almost Famous Podcast')
    expect(feedback).toContain('a small item from Diane Von Furstenberg')
    expect(feedback).toContain('a lower-cost visit to Victoria')
    expect(feedback).toContain('Qloo also gave book, brand, destination and podcast results')
    expect(state.cards).toHaveLength(4)
    expect(events.filter((e) => e.t === 'cards').at(-1)).toMatchObject({ cards: expect.arrayContaining([expect.objectContaining({ entity: expect.objectContaining({ id: 'V' }) })]) })
  })

  it('refuses a repeated set of refused gift ids with a change instruction', async () => {
    const st = laterState()
    st.budget_max = 60
    st.found = {
      A: { entity: { id: 'A', name: 'Brand A', type: 'brand' }, seeds: [], from_call: 1 },
      B: { entity: { id: 'B', name: 'Book B', type: 'book' }, seeds: [], from_call: 1 },
    }
    const refused = [card('A', 'An expensive item', 90, 100), card('MISSING', 'An invented gift')]
    const model = scripted([
      reply([call('present_gifts', { cards: refused })]),
      reply([call('present_gifts', { cards: refused })]),
      reply([call('present_gifts', { cards: [card('A', 'A small item', 20, 30), card('B', 'A copy of Book B', 20, 30)] })]),
    ])
    const { events, state } = await turn(model, 'Cheaper please', st)
    expect(model.seen[2].at(-1)).toMatchObject({ role: 'tool', content: expect.stringMatching(/^Those are the same ideas again\. Choose different ideas and change them as advised:/) })
    expect(model.seen).toHaveLength(3)
    expect(state.cards.map((c) => c.entity.id)).toEqual(['A', 'B'])
    expect(events.filter((e) => e.t === 'cards')).toHaveLength(2)
  })

  it('keeps the existing no-Qloo wording and names returned kinds that were unused', async () => {
    const st = laterState()
    st.found.B = { entity: { id: 'B', name: 'Book B', type: 'book' }, seeds: [], from_call: 1 }
    const model = scripted([
      reply([call('present_gifts', { cards: [card('INVENTED', 'A made-up gift')] })]),
      reply([call('present_gifts', { cards: [card('B', 'A copy of Book B')] })]),
    ])
    await turn(model, 'One book', st)
    const feedback = model.seen[1].at(-1)?.content ?? ''
    expect(feedback).toContain('None of those rest on a taste_insights result. Use the ids it returned.')
    expect(feedback).toContain('Qloo also gave book results (Book B): add one idea for each.')
  })
})

describe('the drop rule', () => {
  const state: ConversationState = {
    ...newState('x'), turn: 1,
    found: { E1: { entity: { id: 'E1', name: 'Fender', type: 'brand', affinity: 0.93 }, seeds: ['Phoebe Bridgers'], from_call: 2 } },
  }
  const p = (entity_id: string, low = 20, high = 40) => ({ entity_id, gift: 'g ' + entity_id, why: 'w', price_low: low, price_high: high })

  it('flattens buckets round robin and drops ideas under the wrong kind', () => {
    const ideas = { book: [p('K')], brand: [p('B'), p('B2')], place: [p('L')], destination: [p('D')], podcast: [p('P')], artist: [p('A')] }
    expect(flattenIdeas(ideas).map((x) => x.entity_id)).toEqual(['K', 'B', 'L', 'D', 'P', 'A', 'B2'])
    const st: ConversationState = { ...state, found: { K: { entity: { id: 'K', name: 'Book', type: 'book' }, seeds: [], from_call: 1 } } }
    expect(checkCards(flattenIdeas({ brand: [p('K')] }), st).dropped).toEqual([{ gift: 'g K', reason: 'put under the wrong kind' }])
  })

  it('drops an invented entity, a repeat and a card over the budget, and caps the high price at the budget', () => {
    const { cards, dropped } = checkCards([p('E1', 30, 90), p('E1'), p('NOPE'), p('E1')], state, 60)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ price_low: 30, price_high: 60, entity: { name: 'Fender', affinity: 0.93 } })
    expect(dropped.map((d) => d.reason)).toEqual(['the same Qloo result as another card', 'no Qloo result behind it', 'the same Qloo result as another card'])
    expect(checkCards([p('E1', 70, 90)], state, 60).dropped[0].reason).toBe('over the budget')
  })

  it('sends an empty tag seed list, so a seed Qloo gave no share is not shown as an unscored seed', () => {
    const lagavulin = { ...state, found: { E1: { entity: { id: 'E1', name: 'Ullapool', type: 'destination', affinity: 0.89, shares: [{ name: 'Lagavulin', share: 1 }] }, seeds: ['John le Carré', 'Lagavulin'], tag_seeds: [], from_call: 6 } } }
    expect(checkCards([p('E1')], lagavulin).cards[0].tag_seeds).toEqual([])
  })

  it('copies seed shares from a grounded result and leaves them off a result without shares', () => {
    const shared = { ...state, found: { E1: { ...state.found.E1, entity: { ...state.found.E1.entity, shares: [{ name: 'Phoebe Bridgers', share: 0.8 }] } } } }
    const withShare = checkCards([p('E1')], shared).cards[0]
    const withoutShare = checkCards([p('E1')], state).cards[0]
    expect(withShare.seed_shares).toEqual([{ name: 'Phoebe Bridgers', share: 0.8 }])
    expect(withoutShare).not.toHaveProperty('seed_shares')
  })

  it('keeps at most two of one kind, and at most six', () => {
    const many: ConversationState = { ...state, found: {} }
    const kinds = ['brand', 'book', 'place', 'podcast']
    for (let i = 0; i < 8; i++) many.found['E' + i] = { entity: { id: 'E' + i, name: 'N' + i, type: kinds[i % 4] }, seeds: [], from_call: 1 }
    const six = checkCards(Array.from({ length: 8 }, (_, i) => p('E' + i)), many)
    expect(six.cards).toHaveLength(6)
    expect(six.dropped).toHaveLength(2)
    const pods: ConversationState = { ...state, found: {} }
    for (let i = 0; i < 3; i++) pods.found['P' + i] = { entity: { id: 'P' + i, name: 'Pod' + i, type: 'podcast' }, seeds: [], from_call: 1 }
    expect(checkCards([p('P0'), p('P1'), p('P2')], pods).dropped).toEqual([{ gift: 'g P2', reason: 'a third podcast' }])
  })

  it('drops a title with a strong swear word', () => {
    const st: ConversationState = { ...newState('r'), turn: 1, found: { X: { entity: { id: 'X', name: "Didn't Nobody Give a Shit What Happened to Carlotta", type: 'book' }, seeds: [], from_call: 1 } } }
    expect(checkCards([p('X')], st).dropped[0].reason).toBe('a title with a swear word, not for a gift card')
  })
})

describe('gift why lines', () => {
  const state: ConversationState = {
    ...newState('why'), turn: 1,
    found: {
      UGLY: { entity: { id: 'UGLY', name: 'Quite Ugly One Morning', type: 'book' }, seeds: ['Le Carre', 'single malt'], from_call: 1 },
      FALLEN: { entity: { id: 'FALLEN', name: 'Fallen Angel', type: 'book' }, seeds: ['Le Carre', 'single malt'], from_call: 1 },
      PHOEBE: { entity: { id: 'PHOEBE', name: 'Song Exploder', type: 'podcast' }, seeds: ['Phoebe Bridgers'], from_call: 1 },
      AUTHOR: { entity: { id: 'AUTHOR', name: 'A gift idea', type: 'destination' }, seeds: ['John le Carre'], from_call: 1 },
      LIVE: { entity: { id: 'LIVE', name: 'Quite Ugly One Morning', type: 'podcast' }, seeds: ['John le Carré', 'Lagavulin'], from_call: 4 },
    },
  }
  const proposed = (entity_id: string, why: string) => ({ entity_id, gift: 'A copy of a book', why, price_low: 20, price_high: 40 })

  it('replaces why lines that name a seed as the maker', () => {
    const { cards } = checkCards([
      proposed('UGLY', 'A compelling Le Carre novel with a gripping storyline.'),
      proposed('FALLEN', 'A gripping Le Carre novel with a complex plot.'),
      proposed('PHOEBE', 'A song by Bridgers.'),
      proposed('AUTHOR', "A John le Carre's novel."),
      proposed('LIVE', 'A compelling Le Carre novel with a gripping storyline'),
    ], state)
    expect(cards.map((c) => c.why)).toEqual([
      'Loved by fans of Le Carre and single malt.',
      'Loved by fans of Le Carre and single malt.',
      'Loved by fans of Phoebe Bridgers.',
      'Loved by fans of John le Carre.',
      'Loved by fans of John le Carré and Lagavulin.',
    ])
  })

  it('keeps allowed style and other mentions of a seed unchanged', () => {
    const { cards } = checkCards([
      proposed('UGLY', "A gripping novel that matches his love for Le Carre's style"),
      proposed('FALLEN', 'A cozy spot for Korean style shaved ice and coffee'),
      proposed('PHOEBE', 'A playlist for a Phoebe Bridgers fan'),
    ], state)
    expect(cards.map((c) => c.why)).toEqual([
      "A gripping novel that matches his love for Le Carre's style",
      'A cozy spot for Korean style shaved ice and coffee',
      'A playlist for a Phoebe Bridgers fan',
    ])
  })
})

describe('reading the model', () => {
  it('omits the tools key when Workers AI is asked to answer without tools', async () => {
    let received: Record<string, unknown> | undefined
    const model = new WorkersAiModel({ async run(_name, input) {
      received = input as Record<string, unknown>
      return { response: 'ok' }
    } })
    await model.chat([{ role: 'user', content: 'compare' }], [], 900)
    expect(received).toBeDefined()
    expect(Object.hasOwn(received!, 'tools')).toBe(false)
  })

  it('reads the chat completion shape and the flat shape', () => {
    const a = readReply({ choices: [{ message: { content: 'hi', tool_calls: [call('search_tags', { query: 'x' })] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
    expect(a).toMatchObject({ content: 'hi', prompt_tokens: 5, completion_tokens: 2 })
    expect(a.tool_calls[0].function.name).toBe('search_tags')
    const b = readReply({ response: null, tool_calls: [{ name: 'search_tags', arguments: { query: 'x' } }] })
    expect(b.tool_calls[0]).toMatchObject({ id: 'call_0', function: { name: 'search_tags', arguments: '{"query":"x"}' } })
  })

  it('marks a reply cut by the output cap', async () => {
    const model = new WorkersAiModel({ async run() {
      return { choices: [{ finish_reason: 'length', message: { content: 'partial' } }], usage: { prompt_tokens: 5, completion_tokens: 900 } }
    } })
    const r = await model.chat([{ role: 'user', content: 'ideas' }], [], 900)
    expect(r.cut).toBe(true)
    expect(readReply({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }).cut).toBe(true)
    expect(readReply({ choices: [{ finish_reason: 'stop', message: { content: 'partial' } }], usage: { completion_tokens: 900 } }, undefined, 900).cut).toBe(true)
    expect(readReply({ response: 'old shape' }).cut).toBe(false)
  })

  it('reads tool calls the model wrote as text in its reasoning, and uses its own neuron count', () => {
    const r = readReply({
      choices: [{ message: { content: null, reasoning: '<tool_call>\n{"name": "search_tags", "arguments": {"query": "Korean"}}\n</tool_call>\n<tool_call>\n{"name": "broken", ' } }],
      usage: { prompt_tokens: 1652, completion_tokens: 95, neurons: 10.53 },
    })
    expect(r.tool_calls).toHaveLength(1)
    expect(r.tool_calls[0].function).toEqual({ name: 'search_tags', arguments: '{"query":"Korean"}' })
    expect(r.neurons).toBe(10.53)
    expect(r.content).toBe('')
  })

  it('reads the live bare call with a missing closing brace and removes it from content', () => {
    const r = readReply({ choices: [{ message: { content: LIVE_BARE_CALL, tool_calls: [] } }] }, ['present_gifts'])
    expect(r.tool_calls).toHaveLength(1)
    expect(r.tool_calls[0].function.name).toBe('present_gifts')
    expect(JSON.parse(r.tool_calls[0].function.arguments).ideas.brand[0].gift).toBe('A Marc Jacobs scarf')
    expect(r.content).toBe('')
  })

  it('reads a bare call inside json fences', () => {
    const bare = JSON.stringify({ name: 'present_gifts', arguments: { ideas: { brand: [] } } })
    const r = readReply({ choices: [{ message: { content: '```json\n' + bare + '\n```', tool_calls: [] } }] }, ['present_gifts'])
    expect(r.tool_calls).toHaveLength(1)
    expect(r.tool_calls[0].function.name).toBe('present_gifts')
    expect(r.content).toBe('')
  })

  it('keeps prose that mentions a tool without a JSON call', () => {
    const content = 'Please use present_gifts to suggest something thoughtful.'
    const r = readReply({ choices: [{ message: { content, tool_calls: [] } }] }, ['present_gifts'])
    expect(r.tool_calls).toEqual([])
    expect(r.content).toBe(content)
  })

  it('does not read a bare call for a tool that was not offered', () => {
    const content = JSON.stringify({ name: 'buy_gift', arguments: { item: 'scarf' } })
    const r = readReply({ choices: [{ message: { content, tool_calls: [] } }] }, ['present_gifts'])
    expect(r.tool_calls).toEqual([])
    expect(r.content).toBe(content)
  })

  it('uses reasoning as answer content when content is null and there are no tool calls', () => {
    const answer = '[{"gift":"Le Carre novel","name":"John le Carre","kind":"author"}]'
    const r = readReply({ choices: [{ message: { content: null, reasoning: answer, tool_calls: [] } }], response: null })
    expect(r.content).toBe(answer)
    expect(r.tool_calls).toEqual([])
  })

  it('removes the reasoning block', () => {
    expect(stripThinking('<think>hmm</think>\n\nHello')).toBe('Hello')
    expect(stripThinking('half a thought</think>Hello')).toBe('Hello')
  })
})

describe('plain words and named cities', () => {
  it('turns long dashes into commas and a hyphen between words into a space, and leaves numbers alone', () => {
    expect(plain('A cozy Peruvian-Latin kitchen — great for dinner')).toBe('A cozy Peruvian Latin kitchen, great for dinner')
    expect(plain('Korean-Chinese dumplings, 2-for-1')).toBe('Korean Chinese dumplings, 2-for-1')
  })

  it('knows a city they named from one they did not', () => {
    expect(saidIn('Toronto', ['She lives in Toronto.'])).toBe(true)
    expect(saidIn('New York', ['My dad. Le Carre novels and single malt.'])).toBe(false)
  })
})

describe('the budget they said', () => {
  it('is read from the message, and the lower of it and the model budget holds', async () => {
    const { budgetIn } = await import('../../src/agent/agent')
    expect(budgetIn('Birthday, under 60 dollars.')).toBe(60)
    expect(budgetIn('Make it cheaper, under 30 dollars.')).toBe(30)
    expect(budgetIn('up to $100 please')).toBe(100)
    expect(budgetIn('My dad. Christmas.')).toBeUndefined()
    const st = laterState()
    st.budget_max = 60
    st.found.T = { entity: { id: 'T', name: 'Ojai', type: 'destination', affinity: 0.9 }, seeds: [], from_call: 1 }
    st.found.U = { entity: { id: 'U', name: 'Island', type: 'book', affinity: 0.88 }, seeds: [], from_call: 1 }
    const model = scripted([
      reply([call('present_gifts', { cards: [card('T', 'A day trip to Ojai', 50, 75), card('U', 'A copy of Island', 15, 25)] })]),
      reply([call('present_gifts', { cards: [card('T', 'A day trip to Ojai', 50, 75), card('U', 'A copy of Island', 15, 25)] })]),
    ])
    const { events, state } = await turn(model, 'Make it cheaper, under 30 dollars.', st)
    const cards = events.find((e) => e.t === 'cards') as Extract<ScoutEvent, { t: 'cards' }>
    expect(cards.dropped).toEqual([{ gift: 'A day trip to Ojai', reason: 'over the budget' }])
    expect(state.budget_max).toBe(30)
  })

  it('drops a card too small to be a gift', () => {
    const st: ConversationState = { ...newState('s'), turn: 1, found: { P: { entity: { id: 'P', name: 'Las Culturistas', type: 'podcast' }, seeds: [], from_call: 1 } } }
    expect(checkCards([{ entity_id: 'P', gift: 'A podcast episode', why: 'It is funny.', price_low: 1, price_high: 1 }], st).dropped[0].reason).toBe('too small to be a gift')
  })
})

describe('who the gift is for', () => {
  it('puts the plan age and gender on every insights call, and the panel shows them', async () => {
    const model = scripted([
      reply([call('plan_scout', { loves: [{ name: 'Phoebe Bridgers', kind: 'named' }], gender: 'male', age: '55_and_older' })]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]),
    ])
    const { asked, events } = await turn(model, 'My dad, 60, loves Phoebe Bridgers.')
    const insights = asked.filter((u) => u.pathname === '/v2/insights')
    expect(insights).toHaveLength(4)
    for (const u of insights) {
      expect(u.searchParams.get('signal.demographics.age')).toBe('55_and_older')
      expect(u.searchParams.get('signal.demographics.gender')).toBe('male')
    }
    expect(events.find((e) => e.t === 'call' && e.tool === 'taste_insights')).toMatchObject({ args: { audience_age: '55_and_older', audience_gender: 'male' } })
  })

  it('asks Qloo with no audience signal when the plan gives none', async () => {
    const model = scripted([reply([call('plan_scout', PLAN)]), reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })])])
    const { asked } = await turn(model, 'Taylor Swift and baking.')
    expect(asked.some((u) => u.searchParams.has('signal.demographics.gender'))).toBe(false)
  })

  it('uses the first message pronouns for every insights request', async () => {
    const model = scripted([reply([call('plan_scout', PLAN)]), reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })])])
    const { asked, events } = await turn(model, 'My brother. He loves Taylor Swift.')
    const insights = asked.filter((url) => url.pathname === '/v2/insights')
    expect(insights.length).toBeGreaterThan(0)
    expect(insights.every((url) => url.searchParams.get('signal.demographics.gender') === 'male')).toBe(true)
    expect(events.filter((event) => event.t === 'call' && event.tool === 'taste_insights').every((event) => event.t === 'call' && event.args.audience_gender === 'male')).toBe(true)
  })

  it('omits the gender signal when the first message does not make it plain', async () => {
    const model = scripted([reply([call('plan_scout', { ...PLAN, gender: 'male' })]), reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })])])
    const { asked } = await turn(model, 'Taylor Swift and baking.')
    const insights = asked.filter((url) => url.pathname === '/v2/insights')
    expect(insights.length).toBeGreaterThan(0)
    expect(insights.every((url) => !url.searchParams.has('signal.demographics.gender'))).toBe(true)
  })
})

describe('Channel3 products', () => {
  it('removes one leading gift phrase from a product query', () => {
    for (const [gift, query] of [
      ['A copy of The Left Hand of Darkness', 'The Left Hand of Darkness'],
      ['A bottle of Laphroaig single malt', 'Laphroaig single malt'],
      ['A subscription to The New Yorker', 'The New Yorker'],
      ['A gift card for Fender', 'Fender'],
      ['A set of Le Creuset bowls', 'Le Creuset bowls'],
      ['A Fender strap', 'Fender strap'],
      ['An artist print', 'artist print'],
      ['The John le Carré book', 'John le Carré book'],
    ]) expect(productQuery(gift)).toBe(query)
  })

  const product = (title: string, price: number, brand?: string) => ({ id: title, title, price, currency: 'USD', url: 'https://shop.test/item', ...(brand ? { brand } : {}) })
  it('picks the first product in band whose title or brand matches the entity, folding accents', () => {
    const entity = 'John le Carré'
    expect(pickProduct({ ok: true, products: [product('John le Carré novel', 35)] }, entity, 40)?.price).toBe(35)
    expect(pickProduct({ ok: true, products: [product('The Complete Works', 35, 'John le Carré Books')] }, entity, 40)?.title).toBe('The Complete Works')
  })

  it('rejects over band, under minimum, and wrong entity products', () => {
    expect(pickProduct({ ok: true, products: [product('Fender strap', 41)] }, 'Fender', 40)).toBeUndefined()
    expect(pickProduct({ ok: true, products: [product('Fender strap', 4.99)] }, 'Fender', 40)).toBeUndefined()
    expect(pickProduct({ ok: true, products: [product('Gibson strap', 30)] }, 'Fender', 40)).toBeUndefined()
  })
  it('picks only USD products, ignoring currency case', () => {
    const cad = { ...product('Fender strap', 30), currency: 'CAD' }
    const lowerUsd = { ...product('Fender strap', 30), currency: 'usd' }
    expect(pickProduct({ ok: true, products: [cad] }, 'Fender', 40)).toBeUndefined()
    expect(pickProduct({ ok: true, products: [cad, lowerUsd] }, 'Fender', 40)).toBe(lowerUsd)
  })

  it('prefixes brand searches by gender and leaves book searches alone', async () => {
    const model = scripted([reply([call('plan_scout', PLAN)]), reply([call('present_gifts', { cards: [
      card('B-FENDER', 'A Fender strap'), card('K-HOMESICK', 'A copy of Homesick'), card('L-NAMOO', 'Dinner at Cafe Namoo'), card('D-SEOUL', 'A trip to Seoul'),
    ] })]), reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap'), card('K-HOMESICK', 'A copy of Homesick'), card('L-NAMOO', 'Dinner at Cafe Namoo'), card('D-SEOUL', 'A trip to Seoul')] })])])
    const { ctx } = qloo()
    const events: ScoutEvent[] = [], searches: unknown[] = []
    const products = { async search(query: string, opts?: { limit?: number; maxPrice?: number }) {
      searches.push({ query, opts })
      return { ok: true as const, products: [product('Fender woven strap', 35)] }
    } }
    const next = await runTurn({ message: 'My brother. He loves Taylor Swift and Korean food. He lives in Toronto. Under 60 dollars.', state: newState('conv1'), model, tools: qlooTools(), ctx, budget: budget(), products, now: () => 10, emit: (e) => { events.push(e) } })
    expect(searches.map((search) => (search as { query: string }).query)).toEqual(["men's Fender strap", 'Homesick'])
    expect(next.cards[0].product).toMatchObject({ title: 'Fender woven strap', price: 35, source: 'channel3' })
    expect(next.cards[1].product).toBeUndefined()
    const calls = events.filter((e) => e.t === 'call')
    expect(calls.find((event) => event.t === 'call' && event.tool === 'search_products')).toMatchObject({ tool: 'search_products', args: { query: "men's Fender strap", max_price: 40 } })
    expect(events.find((e) => e.t === 'result' && e.tool === 'search_products')).toMatchObject({ ok: true, top: [{ name: 'Fender woven strap', type: 'product', price: 35 }] })
    const shown = events.find((e) => e.t === 'cards') as Extract<ScoutEvent, { t: 'cards' }>
    expect(shown.cards).toEqual(expect.arrayContaining([expect.objectContaining({ product: { title: 'Fender woven strap', price: 35, url: 'https://shop.test/item', source: 'channel3' } })]))
  })

  it.each(['capped', 'spent'] as const)('keeps cards and finishes when product search is %s', async (reason) => {
    const model = scripted([reply([call('plan_scout', PLAN)]), reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]), reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })])])
    const { ctx } = qloo(), events: ScoutEvent[] = []
    const next = await runTurn({ message: SISTER, state: newState('conv1'), model, tools: qlooTools(), ctx, budget: budget(), products: { search: async () => ({ ok: false, reason }) }, now: () => 1, emit: (e) => { events.push(e) } })
    expect(next.cards[0].product).toBeUndefined()
    expect(events.at(-1)?.t).toBe('usage')
    expect(events.find((e) => e.t === 'result' && e.tool === 'search_products')).toMatchObject({ ok: false, text: expect.any(String) })
  })

  it('leaves no finder turns with the original Qloo and cards events only', async () => {
    const model = scripted([reply([call('plan_scout', PLAN)]), reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]), reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })])])
    const { ctx } = qloo(), events: ScoutEvent[] = []
    await runTurn({ message: SISTER, state: newState('conv1'), model, tools: qlooTools(), ctx, budget: budget(), now: () => 10, emit: (e) => { events.push(e) } })
    expect(events.filter((e) => e.t === 'call').map((e) => e.tool)).toEqual(['search_entities', 'search_tags', 'taste_insights', 'taste_insights', 'taste_insights', 'taste_insights', 'taste_insights'])
    expect(events.some((e) => e.t === 'call' && e.tool === 'search_products')).toBe(false)
    expect(events.filter((e) => e.t === 'result').map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})

describe('error states', () => {
  /** A Qloo that answers searches with a fixed best match, or fails every call with a 500. */
  function qlooWith(answer: (url: URL) => { status: number; body: unknown }) {
    const asked: URL[] = []
    const m = new Map<string, string>()
    const cache: Cache = { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } }
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); asked.push(url)
      const { status, body } = answer(url)
      return new Response(JSON.stringify(body), { status })
    }) as typeof fetch
    return { ctx: { qloo: new QlooClient('k', fetcher, cache, async () => true) }, asked }
  }
  async function run(model: Model, ctx: { qloo: QlooClient }, message = 'My uncle loves Zzqxv Blorpt.') {
    const events: ScoutEvent[] = []
    await runTurn({ message, state: newState('e1'), model, tools: qlooTools(), ctx, budget: budget(), emit: (e) => { events.push(e) } })
    return events
  }

  it('does not seed with a near match for a name Qloo does not know, says so, and spends no more model calls', async () => {
    const { ctx, asked } = qlooWith(() => ({ status: 200, body: { results: [{ entity_id: 'X1', name: 'Blondie', types: ['urn:entity:artist'] }] } }))
    const model = scripted([reply([call('plan_scout', { loves: [{ name: 'Zzqxv Blorpt', kind: 'named' }] })])])
    const events = await run(model, ctx)
    expect(model.seen).toHaveLength(1)
    expect(asked.some((u) => u.pathname === '/v2/insights')).toBe(false)
    expect(events.find((e) => e.t === 'say')).toMatchObject({ text: expect.stringMatching(/^Qloo does not know Zzqxv Blorpt\. Try a favourite/) })
    expect(events.some((e) => e.t === 'error')).toBe(false)
  })

  it('keeps going on the loves Qloo knows, and names the one it does not', async () => {
    const { ctx } = qlooWith((url) => {
      if (url.pathname === '/search' && url.searchParams.get('query') === 'Phoebe Bridgers') return { status: 200, body: { results: [{ entity_id: PB, name: 'Phoebe Bridgers', types: ['urn:entity:artist'] }] } }
      if (url.pathname === '/search') return { status: 200, body: { results: [{ entity_id: 'X1', name: 'Blondie', types: ['urn:entity:artist'] }] } }
      return { status: 200, body: { results: { entities: [{ entity_id: 'B-FENDER', name: 'Fender', subtype: 'urn:entity:brand', query: { affinity: 0.93 } }] } } }
    })
    const model = scripted([
      reply([call('plan_scout', { loves: [{ name: 'Phoebe Bridgers', kind: 'named' }, { name: 'Zzqxv Blorpt', kind: 'named' }] })]),
      reply([call('present_gifts', { cards: [card('B-FENDER', 'A Fender strap')] })]),
    ])
    const events = await run(model, ctx, 'My sister loves Phoebe Bridgers and Zzqxv Blorpt.')
    expect(events.find((e) => e.t === 'say')).toMatchObject({ text: 'Qloo does not know Zzqxv Blorpt, so these rest on Phoebe Bridgers.' })
    expect((events.find((e) => e.t === 'cards') as { cards: unknown[] }).cards).toHaveLength(1)
  })

  it('says Qloo is not answering when every Qloo call fails, with no misleading advice and no more model calls', async () => {
    const { ctx } = qlooWith(() => ({ status: 500, body: { errors: [{ message: 'internal error' }] } }))
    const model = scripted([reply([call('plan_scout', PLAN)])])
    const events = await run(model, ctx, SISTER)
    expect(model.seen).toHaveLength(1)
    const errors = events.filter((e) => e.t === 'error')
    expect(errors).toEqual([{ t: 'error', text: 'Qloo is not answering right now. The three examples still work.' }])
  })
})
