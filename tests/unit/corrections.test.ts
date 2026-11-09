import { describe, expect, it } from 'vitest'
import { checkCards, contextFor, newState, runTurn, type ConversationState } from '../../src/agent/agent'
import type { ScoutEvent } from '../../src/agent/events'
import type { ChatMessage, Model, ModelReply, ToolCall } from '../../src/agent/model'
import * as text from '../../src/agent/text'
import { QlooClient } from '../../src/qloo/client'
import { qlooTools } from '../../src/qloo/tools'
// @ts-expect-error The public renderer has no declaration.
import { cardHtml } from '../../public/render.js'

const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
const E = '00000000-0000-4000-8000-000000000003'
const TAG = 'urn:tag:genre:place:restaurant:korean'
const idea = { entity_id: E, gift: 'A gift from Cedar', why: 'A thoughtful gift for him.', price_low: 20, price_high: 30 }
const tc = (name: string, args: unknown): ToolCall => ({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const present = () => tc('present_gifts', { cards: [idea] })
const insights = (seed_ids: string[], take = 1, seed_tags?: string[]) => tc('taste_insights', { seed_ids, target_type: 'brand', take, ...(seed_tags ? { seed_tags } : {}) })

function script(turns: ToolCall[][]) {
  const seen: ChatMessage[][] = []
  const model: Model = { name: 'script', async chat(messages) {
    seen.push(structuredClone(messages))
    const tool_calls = turns.shift()
    if (!tool_calls) throw new Error('Script exhausted')
    return { content: '', tool_calls, prompt_tokens: 10, completion_tokens: 10, cut: false } satisfies ModelReply
  } }
  return { model, seen }
}

async function run(message: string, state: ConversationState, turns: ToolCall[][], scores = [0.9]) {
  const { model, seen } = script(turns)
  const events: ScoutEvent[] = []
  const urls: URL[] = []
  const ctx = { qloo: new QlooClient('test', (async (input) => {
    const url = new URL(String(input))
    urls.push(url)
    let body: unknown
    if (url.pathname === '/search' && url.searchParams.get('query') === 'single malt') {
      body = { results: [{ entity_id: A, name: 'Lagavulin', types: ['urn:entity:brand'] }] }
    } else if (url.pathname === '/search') {
      const name = url.searchParams.get('query') === 'Birch' ? 'Birch' : 'Aspen'
      body = { results: [{ entity_id: name === 'Aspen' ? A : B, name, types: ['urn:entity:artist'] }] }
    } else if (url.pathname === '/v2/tags') {
      body = { results: { tags: [{ id: TAG, name: 'Korean', type: 'urn:tag:genre:place' }] } }
    } else {
      body = { results: { entities: url.searchParams.get('filter.type') === 'urn:entity:brand'
        ? [{ entity_id: E, name: 'Cedar', subtype: 'urn:entity:brand', query: { affinity: scores.shift() ?? 0.2 } }]
        : [] } }
    }
    return new Response(JSON.stringify(body))
  }) as typeof fetch, { get: async () => null, put: async () => {} }, async () => true) }
  const next = await runTurn({ message, state, model, tools: qlooTools(), ctx,
    budget: { allow: async () => true, reserve: async () => ({ settle: async () => {} }) },
    emit: (event) => { events.push(structuredClone(event)) },
  })
  return { state: next, events, seen, urls }
}

async function first(mixed = false) {
  return run(`He loves Aspen${mixed ? ' and Birch' : ''}.`, newState('corrections'), [
    [tc('plan_scout', { loves: [{ name: 'Aspen', kind: 'named' }, ...(mixed ? [{ name: 'Birch', kind: 'named' }] : [])] })], [present()],
  ])
}

describe('taking back an interest', () => {
  it('withdraws the old cards before an error when the next request fails', async () => {
    const old = await first()
    const next = await run('forget Aspen', old.state, [])
    const withdrawn = next.events.findIndex((event) => event.t === 'cards_withdrawn')
    expect(next.events[withdrawn]).toEqual({ t: 'cards_withdrawn', cards: old.state.cards.map((card) => card.id), names: ['Aspen'] })
    expect(withdrawn).toBeLessThan(next.events.findIndex((event) => event.t === 'error'))
    expect(next.seen).toHaveLength(1)
    expect(next.state.cards).toEqual([])
  })

  it.each([
    ['he has no jazz records yet', 'jazz', []],
    ['without jazz records yet', 'jazz', []],
    ['no jazz, please', 'jazz', ['jazz']],
    ['no jazz. Thanks', 'jazz', ['jazz']],
    ['without jazz anymore', 'jazz', ['jazz']],
    ['no jazz any more', 'jazz', ['jazz']],
    ['no jazz this time', 'jazz', ['jazz']],
    ['no jazz but blues', 'jazz', ['jazz']],
    ['no more jazz', 'jazz', ['jazz']],
    ['she is not into jazz', 'jazz', ['jazz']],
    ["she isn't into jazz", 'jazz', ['jazz']],
    ['not a fan of jazz', 'jazz', ['jazz']],
    ['he hates jazz', 'jazz', ['jazz']],
    ['he dislikes jazz', 'jazz', ['jazz']],
    ['he is tired of jazz', 'jazz', ['jazz']],
    ['not only jazz but also blues', 'jazz', []],
    ['not just jazz', 'jazz', []],
  ])('handles clause scope in %s', (message, interest, expected) => {
    expect(text.takenBack(message, [interest])).toEqual(expected)
  })

  it.each([
    'not Aspen', 'no Aspen', 'no more Aspen', 'forget Aspen', 'drop Aspen', 'remove Aspen', 'without Aspen',
    'skip Aspen', 'instead of Aspen', 'he no longer likes Aspen', 'she no longer likes Aspen', 'they no longer like Aspen',
    'he does not like Aspen any more', 'she does not like Aspen', 'they do not like Aspen',
    "he doesn't like Aspen anymore", "they don't like Aspen anymore", 'she doesn’t like Aspen any more',
    'he is over Aspen', 'she is over Aspen', 'they are over Aspen', 'he stopped liking Aspen',
    'not Aspen but Birch', 'not ASPEN but Birch',
  ])('reads %s', (message) => {
    expect(text.takenBack(message, ['Aspen', 'Birch'])).toEqual(['Aspen'])
  })

  it('folds accents and matches whole names only', () => {
    expect(text.takenBack('Forget JOHN LE CARRE, not Aspenwood', ['John le Carré', 'Aspen'])).toEqual(['John le Carré'])
    expect(text.takenBack('Forget art', ['Mart', 'Art Garfunkel'])).toEqual([])
  })

  it('keeps overlapping names separate when only the longer name is taken back', () => {
    expect(text.takenBack('not Art Garfunkel but Art', ['Art', 'Art Garfunkel'])).toEqual(['Art Garfunkel'])
    expect(text.takenBack('forget Korean food', ['Korean', 'Korean food'])).toEqual(['Korean food'])
  })

  it.each(['also Aspen', 'and Aspen', 'not Aspenwood', 'not only Aspen but also Birch', 'no more than $50 for Aspen'])('keeps additions and unrelated negatives: %s', (message) => {
    expect(text.takenBack(message, ['Aspen', 'Birch'])).toEqual([])
  })

  it('takes back coordinated names without taking back a replacement', () => {
    expect(text.takenBack('Forget Aspen and Birch, also Cedar', ['Aspen', 'Birch', 'Cedar'])).toEqual(['Aspen', 'Birch'])
  })

  it('uses a lower fresh score after the person changes their taste', async () => {
    const old = await first()
    expect(old.state.found[E].entity.affinity).toBe(0.9)
    const next = await run('he does not like Aspen any more; also Birch', old.state, [
      [tc('search_entities', { query: 'Birch' }), insights([B])], [present()],
    ], [0.2])
    expect(next.state.dropped_interests).toEqual(['Aspen'])
    expect(next.state.found[E]).toMatchObject({ entity: { affinity: 0.2 }, seeds: ['Birch'] })
    expect(next.state.cards[0]).toMatchObject({ entity: { affinity: 0.2 }, seeds: ['Birch'] })
    expect(next.events.filter((e) => e.t === 'cards').flatMap((e) => e.cards).some((c) => c.entity.affinity === 0.9)).toBe(false)
    expect(old.events.find((e) => e.t === 'cards')).toMatchObject({ cards: [{ entity: { affinity: 0.9 } }] })
    expect(old.state.cards).toHaveLength(1)
  })

  it('removes old results and cards before the next request and names the gifts dropped', async () => {
    const old = await first()
    const next = await run('forget Aspen', old.state, [[present()]])
    expect(next.state.found[E]).toBeUndefined()
    expect(next.state.cards).toEqual([])
    expect(next.seen[0][1].content).not.toContain('Cedar (affinity')
    expect(next.seen[0][1].content).toContain('They no longer want: Aspen. Do not use them as seeds.')
    expect(next.events.find((event) => event.t === 'say')).toEqual({ t: 'say', text: 'Dropped what came from Aspen: A gift from Cedar.' })
    expect(next.events.filter((e) => e.t === 'cards').flatMap((e) => e.cards)).toEqual([])
  })

  it('makes mixed evidence stale, keeps its remaining seeds, and excludes it from context and cards', async () => {
    const old = await first(true)
    const next = await run('forget Aspen', old.state, [[present()]])
    expect(next.state.found[E]).toMatchObject({ seeds: ['Birch'], stale: true })
    expect(contextFor(next.state, 'More')).not.toContain('Cedar (affinity')
    expect(next.state.cards).toEqual([])
    expect(next.events.find((e) => e.t === 'cards')).toMatchObject({ dropped: [{ reason: 'rests on something they took back' }] })
  })

  it('clears stale evidence when the remaining interest is scored again', async () => {
    const old = await first(true)
    const next = await run('forget Aspen', old.state, [[insights([B])], [present()]], [0.2])
    expect(next.state.found[E]).toMatchObject({ seeds: ['Birch'], entity: { affinity: 0.2 } })
    expect(next.state.found[E].stale).toBeUndefined()
    expect(next.state.cards[0].entity.affinity).toBe(0.2)
  })

  it('replaces evidence from an earlier turn even when no interest was removed', async () => {
    const old = await first()
    const next = await run('More ideas', old.state, [[insights([A])], [present()]], [0.2])
    expect(next.state.found[E].entity.affinity).toBe(0.2)
  })

  it('keeps the higher score inside one turn', async () => {
    const old = await first()
    const next = await run('More ideas', old.state, [[insights([A], 1)], [insights([A], 2)], [present()]], [0.8, 0.2])
    expect(next.state.found[E].entity.affinity).toBe(0.8)
    expect(next.state.cards[0].entity.affinity).toBe(0.8)
  })

  it('keeps the higher score when the lower score arrives first inside one turn', async () => {
    const old = await first()
    const next = await run('More ideas', old.state, [[insights([A], 1)], [insights([A], 2)], [present()]], [0.2, 0.8])
    expect(next.state.found[E].entity.affinity).toBe(0.8)
    expect(next.state.cards[0].entity.affinity).toBe(0.8)
  })

  it('uses the new turn even for saved evidence with an old call count', async () => {
    const old = await first()
    old.state.calls = 0
    const next = await run('More ideas', old.state, [[insights([A])], [present()]], [0.2])
    expect(next.state.found[E].entity.affinity).toBe(0.2)
  })

  it('filters taken back ids and tags before calling the taste graph', async () => {
    const old = await first(true)
    old.state.names[TAG] = 'Aspen'
    const next = await run('forget Aspen', old.state, [[insights([A, B], 1, [TAG])], [present()]])
    const url = next.urls.find((u) => u.pathname === '/v2/insights')!
    expect(url.searchParams.get('signal.interests.entities')).toBe(B)
    expect(url.searchParams.has('signal.interests.tags')).toBe(false)
    expect(next.state.found[E].seeds).toEqual(['Birch'])
  })

  it('does not call upstream when all requested seeds were taken back', async () => {
    const old = await first()
    const next = await run('forget Aspen', old.state, [[insights([A])], [present()]])
    expect(next.urls).toEqual([])
    expect(next.state.found[E]).toBeUndefined()
  })

  it('remembers original plan names when a tag uses a shorter name', async () => {
    const old = await run('He loves Korean food.', newState('tags'), [
      [tc('plan_scout', { loves: [{ name: 'Korean food', kind: 'cuisine' }] })], [present()],
    ])
    expect(old.state.found[E].seeds).toEqual(['Korean'])
    const next = await run('forget Korean food', old.state, [[tc('taste_insights', { seed_tags: [TAG], target_type: 'brand' })], [present()]])
    expect(next.state.dropped_interests).toContain('Korean food')
    expect(next.state.found[E]).toBeUndefined()
    expect(next.state.cards).toEqual([])
    expect(next.urls).toEqual([])
  })

  it('remembers a plan interest even when no seed was resolved for it', async () => {
    const old = await run('He loves Maple.', newState('unknown'), [
      [tc('plan_scout', { loves: [{ name: 'Maple', kind: 'named' }] })],
    ])
    const next = await run('forget Maple', old.state, [])
    expect(next.state.dropped_interests).toEqual(['Maple'])
    expect(next.events[0]).toEqual({ t: 'say', text: 'Nothing shown came from Maple.' })
  })

  it('filters a negative interest from a first plan', async () => {
    const next = await run('He likes Birch, not Aspen.', newState('plan'), [
      [tc('plan_scout', { loves: [{ name: 'Aspen', kind: 'named' }, { name: 'Birch', kind: 'named' }] })], [present()],
    ])
    expect(next.urls.filter((u) => u.pathname === '/search').map((u) => u.searchParams.get('query'))).toEqual(['Birch'])
    expect(next.state.found[E].seeds).toEqual(['Birch'])
  })

  it('loads an old saved state and supplies an empty dropped list', async () => {
    const old = await first()
    const legacy = JSON.parse(JSON.stringify(old.state))
    delete legacy.dropped_interests
    const next = await run('Also a book', legacy, [[present()]])
    expect(next.state.dropped_interests).toEqual([])
    expect(next.state.cards).toHaveLength(1)
  })

  it('retains unaffected results, cards, and seeds', async () => {
    const old = await first(true)
    const id = 'unaffected'
    old.state.found[id] = { entity: { id, name: 'Birch book', type: 'book', affinity: 0.7 }, seeds: ['Birch'], from_call: 5 }
    const kept = { ...old.state.cards[0], id: 't1c2', entity: old.state.found[id].entity, seeds: ['Birch'], gift: 'A Birch book' }
    old.state.cards.push(kept)
    const next = await run('forget Aspen', old.state, [])
    expect(next.state.cards).toEqual([kept])
    expect(next.state.found[id]).toEqual(old.state.found[id])
    expect(next.seen[0][1].content).toContain('Birch book (affinity 0.70)')
    expect(next.events.find((event) => event.t === 'say')).toEqual({ t: 'say', text: 'Dropped what came from Aspen: A gift from Cedar.' })
  })

  it('keeps a dropped seed blocked on a later turn after its results are gone', async () => {
    const old = await first()
    const next = await run('forget Aspen', old.state, [])
    const later = await run('More please', next.state, [[insights([A])], [present()]])
    expect(later.urls).toEqual([])
    expect(later.state.cards).toEqual([])
    expect(later.seen[0][1].content).toContain('They no longer want: Aspen. Do not use them as seeds.')
  })

  it('removes a dropped filter even when its seed remains active', async () => {
    const old = await first(true)
    old.state.names[TAG] = 'Aspen'
    const next = await run('forget Aspen', old.state, [[tc('taste_insights', { seed_ids: [B], filter_tags: [TAG], target_type: 'brand' })], [present()]])
    const url = next.urls.find((u) => u.pathname === '/v2/insights')!
    expect(url.searchParams.has('filter.tags')).toBe(false)
    expect(next.state.found[E].seeds).toEqual(['Birch'])
  })

  it('says when no shown card rested on the interest', async () => {
    const old = await first()
    old.state.cards = []
    const next = await run('forget Aspen', old.state, [])
    expect(next.events[0]).toEqual({ t: 'say', text: 'Nothing shown came from Aspen.' })
  })

  it('rejects stale and wholly taken back evidence at the card boundary', async () => {
    const old = await first()
    old.state.dropped_interests = ['ASPEN']
    expect(checkCards([idea], old.state)).toMatchObject({ cards: [], dropped: [{ reason: 'rests on something they took back' }] })
    old.state.found[E].seeds = ['Birch']
    old.state.found[E].stale = true
    expect(checkCards([idea], old.state)).toMatchObject({ cards: [], dropped: [{ reason: 'rests on something they took back' }] })
  })

  it('renders only active shares and tags in the because line', () => {
    const html = cardHtml({ gift: 'Gift', why: 'Thoughtful', price_low: 20, price_high: 30,
      entity: { name: 'Cedar', affinity: 0.2 }, seeds: ['Birch'],
      seed_shares: [{ name: 'Aspen', share: 0.9 }, { name: 'Birch', share: 0.1 }], tag_seeds: ['Aspen'], from_call: 1,
    })
    expect(html).toContain('Birch 100%')
    expect(html).not.toContain('Aspen')
  })
})

describe('leaving out an interest from its button', () => {
  it('drops single malt after it resolved to Lagavulin, withdraws its cards and marks mixed evidence stale', async () => {
    const old = await run('He loves single malt and Birch.', newState('leave-out'), [
      [tc('plan_scout', { loves: [{ name: 'single malt', kind: 'drink' }, { name: 'Birch', kind: 'named' }] })], [present()],
    ])
    const shown = old.state.cards
    expect(shown.length).toBe(1)
    expect(shown[0].seeds).toEqual(expect.arrayContaining(['Lagavulin', 'Birch']))
    const next = await run('Drop single malt.', old.state, [[present()]])
    expect(next.events.find((e) => e.t === 'cards_withdrawn')).toEqual({ t: 'cards_withdrawn', cards: [shown[0].id], names: ['single malt'] })
    expect(next.state.cards.some((card) => card.seeds.includes('Lagavulin'))).toBe(false)
    expect(next.state.found[E]).toMatchObject({ seeds: ['Birch'], stale: true })
    expect(contextFor(next.state, 'More')).not.toContain('Cedar (affinity')
    expect(next.events.find((e) => e.t === 'say')).toEqual({ t: 'say', text: 'Dropped what came from single malt: A gift from Cedar.' })
  })
})
