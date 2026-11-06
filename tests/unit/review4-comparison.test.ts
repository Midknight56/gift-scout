import { expect, it, vi } from 'vitest'
import { parsePlainIdeas, runCompare } from '../../src/agent/compare'
// @ts-expect-error Public renderer has no TypeScript declaration.
import { compareHtml } from '../../public/render.js'
import type { ScoutEvent } from '../../src/agent/events'
import { QlooClient } from '../../src/qloo/client'

async function compare(hit: { id: string; name: string; type: string }, name = 'Lagavulin') {
  const events: ScoutEvent[] = []
  const insights = vi.fn(async () => ({ cached: false, results: [{ ...hit, affinity: 0.9 }] }))
  const qloo = Object.assign(new QlooClient('test', fetch, { get: async () => null, put: async () => {} }, async () => true), {
    search: vi.fn(async () => ({ cached: false, results: [hit] })), insights,
  })
  await runCompare({ message: 'A gift', cards: [], turns: [], qloo,
    model: { name: 'test', chat: async () => ({ content: JSON.stringify([{ gift: 'A whisky bottle', name, kind: 'brand' }]),
      tool_calls: [], prompt_tokens: 0, completion_tokens: 0 }) },
    budget: { allow: async () => true, reserve: async () => ({ settle: async () => {} }) },
    emit: async e => { events.push(e) },
  })
  return { event: events.find(e => e.t === 'compare')!, insights, search: qloo.search }
}

it.each([
  { id: 'NIKE', name: 'Nike', type: 'brand' },
  { id: 'BOOK', name: 'Lagavulin', type: 'book' },
])('leaves an unrelated search identity unresolved: $name $type', async hit => {
  const { event, insights } = await compare(hit)
  expect(event.plain[0]).toMatchObject({ name: 'Lagavulin', found: false })
  expect(event.plain[0]).not.toHaveProperty('affinity')
  expect(event.plain_mean).toBeNull()
  expect(insights).not.toHaveBeenCalled()
})

it('normalizes parsed comparison prose while preserving the lookup name', async () => {
  const ideas = parsePlainIdeas('[{"gift":"A sci-fi novel.","name":"North-Shore","kind":"brand"}]')!
  expect(ideas[0]).toMatchObject({ gift: 'A sci fi novel.', name: 'North Shore', lookup_name: 'North-Shore' })
  const { event, search } = await compare({ id: 'NORTH-SHORE', name: 'North-Shore', type: 'brand' }, 'North-Shore')
  expect(search).toHaveBeenCalledWith('North-Shore', 'brand', 1)
  expect(event.plain[0]).toMatchObject({ name: 'North Shore', matched: { id: 'NORTH-SHORE', name: 'North-Shore' } })
})

it('normalizes saved comparison gifts and names when rendered', () => {
  const html = compareHtml({ plain: [{ gift: 'A sci-fi novel.', name: 'North-Shore', found: false }] })
  expect(html).toContain('A sci fi novel.')
  expect(html).toContain('North Shore')
  expect(html).not.toContain('sci-fi')
  expect(html).not.toContain('North-Shore')
})

it('preserves the verified matched identity with its comparison score', async () => {
  const { event } = await compare({ id: 'LAG', name: 'Lagavulin Co', type: 'brand' })
  expect(event.plain[0]).toMatchObject({ found: true, affinity: 0.9,
    matched: { id: 'LAG', name: 'Lagavulin Co', type: 'brand' } })
})

