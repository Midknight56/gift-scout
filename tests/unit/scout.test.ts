import { afterEach, describe, expect, it } from 'vitest'
import { newState, type Budget } from '../../src/agent/agent'
import type { ScoutEvent } from '../../src/agent/events'
import type { Model, ModelReply, ToolCall } from '../../src/agent/model'
import { EXAMPLES, parseScout, scoutTurn, type RecordedRun, type ScoutDeps } from '../../src/app/scout'
import { ownerToken } from '../../src/app/buy'
import { QlooClient, type Cache } from '../../src/qloo/client'
import { qlooTools } from '../../src/qloo/tools'
import { Conversations, RunCache } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'
// @ts-expect-error Public renderer is an ES module without a TypeScript declaration.
import { cardHtml } from '../../public/render.js'

const dbs: FakeD1[] = []
afterEach(() => { for (const d of dbs.splice(0)) d.close() })

function qlooCtx(key = 'k') {
  const asked: string[] = []
  const m = new Map<string, string>()
  const cache: Cache = { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } }
  const fetcher = (async (input: RequestInfo | URL) => {
    asked.push(String(input))
    if (new URL(String(input)).pathname === '/search') {
      return new Response(JSON.stringify({ results: [{ entity_id: '00000000-0000-4000-8000-000000000001', name: 'Phoebe Bridgers', types: ['urn:entity:artist'] }] }))
    }
    const type = new URL(String(input)).searchParams.get('filter.type')?.replace('urn:entity:', '') ?? 'brand'
    const id: Record<string, string> = { brand: 'B-FENDER', book: 'K-BOOK', podcast: 'P-POD', destination: 'D-DEST', place: 'L-PLACE' }
    return new Response(JSON.stringify({ results: { entities: [{ entity_id: id[type] ?? 'B-FENDER', name: type === 'brand' ? 'Fender' : type, subtype: 'urn:entity:' + type, query: { affinity: 0.93 } }] } }))
  }) as typeof fetch
  return { ctx: { qloo: new QlooClient(key, fetcher, cache, async () => true) }, asked }
}

function strongModel(): Model {
  let calls = 0
  return {
    name: 'strong',
    async chat() {
      calls++
      if (calls === 1) return reply([call('plan_scout', { loves: [{ name: 'Phoebe Bridgers', kind: 'named' }], city: 'Toronto' })])
      return reply([call('present_gifts', { cards: [
        ['B-FENDER', 'brand'], ['K-BOOK', 'book'], ['P-POD', 'podcast'], ['D-DEST', 'destination'], ['L-PLACE', 'place'],
      ].map(([entity_id, kind]) => ({ entity_id, gift: 'Gift ' + kind, why: 'A thoughtful pick.', price_low: 20, price_high: 40 })) })])
    },
  }
}

let n = 0
const call = (name: string, args: unknown): ToolCall => ({ id: 'x' + ++n, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const reply = (calls: ToolCall[]): ModelReply => ({ content: '', tool_calls: calls, prompt_tokens: 100, completion_tokens: 10 })

/** A model that always does the same small run: one insights call, then one card. Counts its calls. */
function model(): Model & { calls: number } {
  const m = {
    name: 'fake', calls: 0,
    async chat(messages: { role: string }[]) {
      m.calls++
      const toolTurns = messages.filter((x) => x.role === 'tool').length
      const present = reply([call('present_gifts', { cards: [{ entity_id: 'B-FENDER', gift: 'A Fender strap', why: 'She plays.', price_low: 25, price_high: 40 }] })])
      // A first turn plans, a later turn presents from what it has.
      if (messages.length > 2 && messages[1].role === 'user' && (messages[1] as unknown as { content: string }).content.startsWith('Earlier')) return present
      return toolTurns === 0 ? reply([call('plan_scout', { loves: [{ name: 'Phoebe Bridgers', kind: 'named' }] })]) : present
    },
  }
  return m
}

const open: Budget = { allow: async () => true, reserve: async () => ({ settle: async () => {} }) }

function deps(over: Partial<ScoutDeps> & { m?: Model; budget?: Budget; visitorOk?: boolean } = {}) {
  const db = new FakeD1(); dbs.push(db)
  let id = 0
  const { ctx, asked } = qlooCtx()
  const d: ScoutDeps = {
    conversations: new Conversations(db), runs: new RunCache(db), recorded: async () => [], tools: qlooTools(),
    live: { model: over.m ?? model(), ctx, budget: over.budget ?? open, takeVisitorTurn: async () => over.visitorOk ?? true },
    newId: () => 'conv' + String(++id).padStart(4, '0'),
    ownerToken: (id) => ownerToken(id, 'test-secret'),
    ...over,
  }
  return { d, asked }
}

async function turn(d: ScoutDeps, message: string, conversation?: string) {
  const events: ScoutEvent[] = []
  await scoutTurn(message, conversation, d, async (e) => { events.push(e) })
  return events
}

const OLD_CARD = { id: 'old-card', gift: 'A Fender strap', why: 'A thoughtful pick.', price_low: 20, price_high: 40,
  entity: { id: 'B-FENDER', name: 'Fender', type: 'brand', affinity: 0.93 }, seeds: ['Phoebe Bridgers', 'Korean'], from_call: 1 }

const RECORDED: RecordedRun = {
  recorded_at: '2026-10-25T15:00:00Z',
  turns: [
    [{ t: 'run', conversation: 'old', turn: 1, mode: 'live' }, { t: 'call', n: 1, tool: 'taste_insights', args: {} },
      { t: 'result', n: 1, tool: 'taste_insights', ok: true, ms: 300, cached: false, text: 'Fender (affinity 0.93)', top: [] },
      { t: 'cards', cards: [OLD_CARD], dropped: [] }, { t: 'usage', model_calls: 3, neurons: 41 }],
    [{ t: 'run', conversation: 'old', turn: 2, mode: 'live' }, { t: 'cards', cards: [], dropped: [] }, { t: 'usage', model_calls: 1, neurons: 9 }],
  ],
  states: [{ ...newState('old'), turn: 1, said: [EXAMPLES[0]], cards: [OLD_CARD] }, { ...newState('old'), turn: 2, said: [EXAMPLES[0], 'Cheaper please'], cards: [OLD_CARD] }],
}

function syntheticRecorded(example: string, id: string, gift: string): RecordedRun {
  const card = { ...OLD_CARD, id, gift, entity: { ...OLD_CARD.entity, id: '00000000-0000-4000-8000-000000000002', affinity: 0.5 } }
  return {
    recorded_at: '2026-01-01T00:00:00Z',
    turns: [[{ t: 'run', conversation: id, turn: 1, mode: 'live', said: example }, { t: 'cards', cards: [card], dropped: [] }, { t: 'usage', model_calls: 1, neurons: 1 }]],
    states: [{ ...newState(id), turn: 1, said: [example], cards: [card] }],
  }
}
const SYNTHETIC_RECORDED = [
  syntheticRecorded(EXAMPLES[0], 'synthetic-one', 'A synthetic music gift'),
  syntheticRecorded(EXAMPLES[1], 'synthetic-two', 'A synthetic book gift'),
  syntheticRecorded(EXAMPLES[2], 'synthetic-three', 'A synthetic activity gift'),
]

describe('a scout turn', () => {
  it('runs live, saves the conversation, and ends with its share link', async () => {
    const { d } = deps()
    const events = await turn(d, 'My sister loves Phoebe Bridgers')
    expect(events[0]).toEqual({ t: 'run', conversation: 'conv0001', turn: 1, mode: 'live', said: 'My sister loves Phoebe Bridgers' })
    expect(events.at(-1)).toEqual({ t: 'done', share: '/s/conv0001' })
    const saved = await d.conversations.get('conv0001')
    expect(saved!.turns).toHaveLength(1)
    expect(saved!.state.cards[0].entity.name).toBe('Fender')
    expect(saved!.turns.flat().some((event) => event.t === 'owner')).toBe(false)
    expect(events[1]).toMatchObject({ t: 'owner', token: await ownerToken('conv0001', 'test-secret') })
  })

  it('does not cache a weak first turn, so the same message gets a live turn', async () => {
    const m = model()
    const { d, asked } = deps({ m })
    await turn(d, 'My sister loves Phoebe Bridgers!')
    const before = { model: m.calls, qloo: asked.length }
    const again = await turn(d, 'my sister  loves phoebe bridgers')
    expect(m.calls).toBeGreaterThan(before.model)
    expect(asked.length).toBe(before.qloo)
    expect(again[0]).toMatchObject({ t: 'run', conversation: 'conv0002', mode: 'live' })
    expect(again.find((e) => e.t === 'cards')).toBeTruthy()
  })

  it('caches a first turn with five cards across three kinds', async () => {
    const { d } = deps({ m: strongModel() })
    await turn(d, 'My sister in Toronto loves Phoebe Bridgers.')
    const next = await turn(d, 'my sister in toronto loves phoebe bridgers')
    expect(next[0]).toMatchObject({ t: 'run', conversation: 'conv0002', mode: 'cache' })
  })

  it('keeps a run with product search apart from one without in the shared cache', async () => {
    const { d } = deps({ m: strongModel() })
    await turn(d, 'My sister in Toronto loves Phoebe Bridgers.')
    const withProducts: ScoutDeps = { ...d, products: { search: async () => ({ ok: false, reason: 'error' }) } as unknown as ScoutDeps['products'] }
    const next = await turn(withProducts, 'my sister in toronto loves phoebe bridgers')
    expect(next[0]).toMatchObject({ t: 'run', mode: 'live' })
  })

  it('with live off (no key), replays a recorded example and its recorded narrowing turn, labelled with the date', async () => {
    const { d } = deps({ live: null, recorded: async () => [RECORDED] })
    const first = await turn(d, EXAMPLES[0])
    expect(first[0]).toEqual({ t: 'run', conversation: 'conv0001', turn: 1, mode: 'replay', recorded_at: '2026-10-25T15:00:00Z', said: EXAMPLES[0] })
    expect(first.map((e) => e.t)).toEqual(['run', 'owner', 'call', 'result', 'cards', 'usage', 'done'])
    expect(first.find((e) => e.t === 'cards')).toMatchObject({ cards: [OLD_CARD] })
    expect(first.find((e) => e.t === 'cards')?.t === 'cards' && first.find((e) => e.t === 'cards')?.cards[0]).not.toHaveProperty('seed_shares')
    expect(cardHtml(OLD_CARD)).toContain('Phoebe Bridgers and Korean')
    const second = await turn(d, 'Cheaper please.', 'conv0001')
    expect(second[0]).toMatchObject({ mode: 'replay', turn: 2 })
    const saved = await d.conversations.get('conv0001')
    expect(saved!.turns).toHaveLength(2)
  })

  it('with live off, says so calmly for any other message', async () => {
    const { d } = deps({ live: null, recorded: async () => [RECORDED] })
    const events = await turn(d, 'My uncle likes jazz')
    expect(events[0]).toMatchObject({ t: 'run', mode: 'off' })
    expect(events.at(-1)).toMatchObject({ t: 'error', text: expect.stringMatching(/off right now.*examples still work/) })
  })

  it('replays an example when the budget is spent, and makes no model call', async () => {
    const m = model()
    const { d } = deps({ m, budget: { allow: async () => false, reserve: async () => null }, recorded: async () => [RECORDED] })
    const events = await turn(d, EXAMPLES[0])
    expect(m.calls).toBe(0)
    expect(events[0]).toMatchObject({ mode: 'replay' })
  })

  it('replays every recorded example when the budget is spent, and makes no model call', async () => {
    for (const example of EXAMPLES) {
      const m = model()
      const { d } = deps({ m, budget: { allow: async () => false, reserve: async () => null }, recorded: async () => SYNTHETIC_RECORDED })
      const events = await turn(d, example)
      expect(events[0]).toMatchObject({ t: 'run', mode: 'replay' })
      expect(events.some((event) => event.t === 'cards')).toBe(true)
      expect(m.calls).toBe(0)
    }
  })

  it('refuses a visitor over their daily turns', async () => {
    const m = model()
    const { d } = deps({ m, visitorOk: false })
    const events = await turn(d, 'My uncle likes jazz')
    expect(m.calls).toBe(0)
    expect(events.at(-1)).toMatchObject({ t: 'error', text: expect.stringMatching(/scouted a lot today/) })
  })

  it('says a lost conversation has gone', async () => {
    const { d } = deps()
    expect(await turn(d, 'cheaper', 'nosuchconv')).toEqual([{ t: 'error', text: 'That conversation has gone. Start a new one.' }])
  })
})

describe('the request', () => {
  const req = (body: unknown) => new Request('https://x/api/scout', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
  it('takes a message and a well formed conversation id, and refuses the rest', async () => {
    expect(await parseScout(req({ message: '  My dad  ', conversation: 'conv0001' }))).toEqual({ ok: true, message: 'My dad', conversation: 'conv0001' })
    expect(await parseScout(req({ message: 'My dad', conversation: '../etc' }))).toEqual({ ok: true, message: 'My dad', conversation: undefined })
    expect((await parseScout(req('not json'))).ok).toBe(false)
    expect((await parseScout(req({ message: 'x' }))).ok).toBe(false)
    expect((await parseScout(req({ message: 'x'.repeat(601) }))).ok).toBe(false)
  })
})

describe('pacing', () => {
  it('spaces the events of a recorded run when a pace is set, and keeps them all in order', async () => {
    const { d } = deps({ live: null, recorded: async () => [RECORDED], paceMs: 40 })
    const times: number[] = []
    const events: ScoutEvent[] = []
    const t0 = Date.now()
    await scoutTurn(EXAMPLES[0], undefined, d, async (e) => { events.push(e); times.push(Date.now() - t0) })
    expect(events.map((e) => e.t)).toEqual(['run', 'owner', 'call', 'result', 'cards', 'usage', 'done'])
    // call 40, result 20, cards 160, usage 20: at least 200 ms before the last saved event.
    expect(times[5]).toBeGreaterThanOrEqual(200)
  })
})
