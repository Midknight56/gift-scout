import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Public renderer has no TypeScript declaration.
import { cardHtml, walkSvg } from '../../public/render.js'

const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8')

const card = {
  id: 'c1', gift: 'Lagavulin 16', why: 'He likes smoky whisky.', price_low: 60, price_high: 90, from_call: 3,
  entity: { name: 'Lagavulin', affinity: 0.9 }, seeds: ['John le Carre'],
  product: { title: 'Lagavulin 16 Year Old', price: 79.99, url: 'https://shop.example.com/l16', currency: 'usd' },
}

describe('current shortlist first', () => {
  it('puts name and price first, then the product, then the short source, then the explanation on request', () => {
    const html = cardHtml(card, { buyable: true })
    const at = (needle: string) => html.indexOf(needle)
    expect(at('class="gift-name"')).toBeGreaterThan(-1)
    expect(at('class="price"')).toBeLessThan(at('class="product-block"'))
    expect(at('class="product-block"')).toBeLessThan(at('class="because"'))
    expect(at('class="because"')).toBeLessThan(at('class="why-more"'))
    expect(html).toContain('<details class="why-more"><summary>Why this one</summary><p class="gift-why">He likes smoky whisky.</p></details>')
    expect(html).toContain('class="call-link"')
  })

  it('tags each graph line and result row with its card number', () => {
    const svg = walkSvg([card, { ...card, id: 'c2', entity: { name: 'Talisker', affinity: 0.8 } }])
    expect(svg.match(/<line [^>]*data-card="1"/g)).toHaveLength(1)
    expect(svg.match(/<line [^>]*data-card="2"/g)).toHaveLength(1)
    expect(svg).toContain('<g data-card="1">')
    expect(svg).toContain('<g data-card="2">')
  })

  it('folds earlier card sets into one closed disclosure', () => {
    expect(app).toContain("box.className = 'earlier-ideas'")
    expect(app).toContain('`Earlier ideas (${')
    expect(app).toMatch(/function collapseEarlier\(/)
  })

  it('selects a card, highlights its graph links and clears on Escape', () => {
    expect(app).toMatch(/walkPanel\.dataset\.selectedCard = /)
    expect(app).toMatch(/e\.key === 'Escape'[\s\S]{0,80}clearSelection\(\)/)
    expect(css).toMatch(/\.walk-panel\[data-selected-card\] \[data-card\]:not\(\.is-selected\) \{[^}]*opacity: \.2/)
  })

  it('keeps the compare button with the current cards, not inside the closed disclosure', () => {
    const compare = app.slice(app.indexOf('function drawCompareButton('), app.indexOf('function drawComparison('))
    expect(compare).not.toContain('firstCardList?.after(actions)')
  })
})
