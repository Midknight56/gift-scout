import { describe, expect, it } from 'vitest'
// @ts-expect-error Browser module has no declaration file.
import { callSummary, callRowHtml } from '../../public/render.js'

describe('review 6: readable request summaries', () => {
  it.each([
    ['search_entities', { query: 'Jean-Paul' }, 'Find "Jean Paul" in Qloo'],
    ['search_products', { query: 'Jean-Paul shirt', max_price: 40 }, 'Find "Jean Paul shirt" to buy, under $40'],
    ['search_tags', { query: 'sci-fi' }, 'Find the tag for "sci fi"'],
    ['check_offer', { title: 'Jean-Paul shirt' }, 'Check the current offer for "Jean Paul shirt"'],
    ['taste_insights', { target_type: 'place', location: 'Clermont-Ferrand' }, 'What fans of a taste love: places in Clermont Ferrand'],
  ])('normalizes visible names for %s without changing the arguments', (tool, args, expected) => {
    const call = { n: 1, t: 'call', tool, args }
    const original = structuredClone(call)
    expect(callSummary(call)).toBe(expected)
    const html = callRowHtml(call)
    expect(html).toContain(expected.replaceAll('"', '&quot;'))
    expect(call).toEqual(original)
    expect(html).toContain(JSON.stringify(args, null, 2).replaceAll('"', '&quot;'))
  })
})
