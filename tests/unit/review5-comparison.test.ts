import { expect, it, vi } from 'vitest'
import { runCompare } from '../../src/agent/compare'
import { QlooClient } from '../../src/qloo/client'
import type { ScoutEvent } from '../../src/agent/events'
// @ts-expect-error Public renderer has no TypeScript declaration.
import { compareHtml } from '../../public/render.js'

async function compareBook(title: string, scoredTitle = title) {
  const events: ScoutEvent[] = []
  const hit = { id: 'BOOK', name: title, type: 'book', tags: [] }
  const insights = vi.fn(async () => ({ cached: false, results: [{ ...hit, name: scoredTitle, affinity: 0.9 }] }))
  const qloo = Object.assign(new QlooClient('test', fetch, { get: async () => null, put: async () => {} }, async () => true), {
    search: vi.fn(async () => ({ cached: false, results: [hit] })), insights,
  })
  await runCompare({ message: 'A book', turns: [], cards: [], qloo,
    model: { name: 'test', chat: async () => ({ content: JSON.stringify([{ gift: 'A copy of The Hobbit', name: 'The Hobbit', kind: 'book' }]), tool_calls: [], prompt_tokens: 0, completion_tokens: 0 }) },
    budget: { allow: async () => true, reserve: async () => ({ settle: async () => {} }) },
    emit: async event => { events.push(event) },
  })
  return { event: events.find(event => event.t === 'compare')!, insights }
}

it.each(['The Hobbit Companion', 'The Hobbit: A Study Guide', 'Hobbit'])('leaves a distinct book unresolved without scoring it: %s', async title => {
  const { event, insights } = await compareBook(title)
  expect.soft(event.plain[0].found).toBe(false)
  expect.soft(event.plain[0]).not.toHaveProperty('affinity')
  expect.soft(insights).not.toHaveBeenCalled()
})

it('accepts a normalized equal book title', async () => {
  const { event, insights } = await compareBook('THE HOBBIT!')
  expect(event.plain[0]).toMatchObject({ found: true, affinity: 0.9 })
  expect(insights).toHaveBeenCalledOnce()
})

it('rejects a different book title in the scoring response', async () => {
  const { event } = await compareBook('The Hobbit', 'The Hobbit Companion')
  expect(event.plain[0]).toMatchObject({ found: false })
  expect(event.plain[0]).not.toHaveProperty('affinity')
})

it('shows a differing accepted matched name in the comparison row', () => {
  const html = compareHtml({ plain: [{ gift: 'A gift', name: 'North Shore', found: true, affinity: 0.9,
    matched: { id: 'NORTH', name: 'North-Shore Co', type: 'brand' } }] })
  expect(html).toContain('Matched: North Shore Co')
  expect(html).not.toContain('North-Shore')
})
