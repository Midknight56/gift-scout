import { describe, expect, it } from 'vitest'
// @ts-expect-error Public renderer has no TypeScript declaration.
import { compareHtml } from '../../public/render.js'

const event = {
  message: 'My dad. Le Carre novels and single malt.',
  cards: [{ gift: 'A spy novel', name: 'The Spy Who Came in from the Cold', affinity: 0.92 }],
  plain: [
    { gift: 'A bottle', name: 'Lagavulin', kind: 'brand', found: true, affinity: 0.81, context: 'same' },
    { gift: 'A trip', name: 'Islay', kind: 'destination', found: true, affinity: 0.6, context: 'nearest' },
    { gift: 'A record', name: 'Nobody Knows', kind: 'artist', found: false, context: 'nearest' },
  ],
  plain_mean: 0.705, qloo_mean: 0.92, not_found: 1,
  plain_same_mean: 0.81, plain_same_found: 1, plain_nearest_mean: 0.6, plain_nearest_found: 1,
  coverage: { plain_found: 2, plain_total: 3, cards_scored: 1, cards_total: 1 },
}

describe('comparison view', () => {
  it('shows the first request, both lists and separate same and nearest summaries', () => {
    const html = compareHtml(event)
    expect(html).toContain('<h3>Comparison of the first request</h3>')
    expect(html).toContain('You asked: &quot;My dad. Le Carre novels and single malt.&quot;')
    expect(html).toContain('Later changes are not part of this comparison.')
    expect(html).toContain('Gift Scout&#39;s picks')
    expect(html).toContain('Plain model&#39;s picks')
    expect(html).toContain('The Spy Who Came in from the Cold')
    expect(html).toContain('not found in Qloo')
    expect(html).toContain('Scored on the nearest signals')
    expect(html).toContain('on the same signals: mean affinity 0.81 over 1')
    expect(html).toContain('on the nearest signals: mean affinity 0.60 over 1')
    expect(html).toContain('Scores on the nearest signals are not a like for like test.')
    expect(html).toContain('It does not show whether they would like the gift')
    expect(html).not.toMatch(/\b(better|wins?|beats?)\b/i)
    expect(html.match(/class="compare-item"/g)).toHaveLength(3)
  })

  it('leaves out a part with no scores and the like for like note when nothing is nearest', () => {
    const html = compareHtml({ ...event, plain: event.plain.slice(0, 1), plain_nearest_mean: null, plain_nearest_found: 0 })
    expect(html).not.toContain('on the nearest signals: mean')
    expect(html).not.toContain('not a like for like test')
  })

  it('renders an old saved event with its old summary and no own list', () => {
    const html = compareHtml({ plain: [{ gift: 'Gift 1', name: 'Name 1', kind: 'book', found: true, affinity: 0.78 }], qloo_mean: 0.91, plain_mean: 0.78, not_found: 0 })
    expect(html).toContain('Gift Scout&#39;s cards: mean affinity 0.91. Plain model: 0.78 over the 1 Qloo knows, 0 of 1 not found.')
    expect(html).not.toContain('Gift Scout&#39;s picks')
    expect(html).not.toContain('You asked:')
  })
})
