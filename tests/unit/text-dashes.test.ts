import { describe, expect, it } from 'vitest'
import { plain } from '../../src/agent/text'
// @ts-expect-error The public renderer has no declaration.
import { cardHtml } from '../../public/render.js'

describe('plain text dashes and hyphens', () => {
  it('converts non-breaking hyphen and spaced em dash', () => {
    const input = 'a single\u2011malt lover \u2014 try this'
    const result = plain(input)
    expect(result).toBe('a single malt lover, try this')
    expect(result).not.toMatch(/\p{L}[-\u2010-\u2015]\p{L}/u)
  })

  it('converts T-shirt with non-breaking hyphen and 12-year with digit on left', () => {
    const res1 = plain('a T\u2011shirt')
    expect(res1).toBe('a T shirt')
    expect(res1).not.toMatch(/\p{L}[-\u2010-\u2015]\p{L}/u)

    const res2 = plain('a 12\u2011year Ardbeg')
    expect(res2).toBe('a 12 year Ardbeg')
    expect(res2).not.toMatch(/\p{L}[-\u2010-\u2015]\p{L}/u)
  })

  it('converts spaced ASCII dash and horizontal bar between words to comma', () => {
    const res1 = plain('smoky - and rich')
    expect(res1).toBe('smoky, and rich')
    expect(res1).not.toMatch(/\p{L}[-\u2010-\u2015]\p{L}/u)

    const res2 = plain('peaty \u2015 bold')
    expect(res2).toBe('peaty, bold')
    expect(res2).not.toMatch(/\p{L}[-\u2010-\u2015]\p{L}/u)
  })

  it('converts U+2010 hyphen and U+2012 figure dash between letters to a space', () => {
    const res1 = plain('x\u2010y')
    expect(res1).toBe('x y')
    expect(res1).not.toMatch(/\p{L}[-\u2010-\u2015]\p{L}/u)

    const res2 = plain('x\u2012y')
    expect(res2).toBe('x y')
    expect(res2).not.toMatch(/\p{L}[-\u2010-\u2015]\p{L}/u)
  })

  it('keeps minus sign before numbers and dashes between digits', () => {
    const res1 = plain('-25 and +25')
    expect(res1).toBe('-25 and +25')
    expect(res1).not.toMatch(/\p{L}[-\u2010-\u2015]\p{L}/u)

    const res2 = plain('10-20')
    expect(res2).toBe('10-20')
    expect(res2).not.toMatch(/\p{L}[-\u2010-\u2015]\p{L}/u)
  })
})

describe('cards saved before the dash fix', () => {
  it('draws model gift and reason text with no dash between words, from a cached run', () => {
    const html = cardHtml({ gift: 'Laphroaig: a 12\u2011year Ardbeg single malt', why: 'A T\u2011shirt \u2014 for him', price_low: 20, price_high: 30,
      entity: { name: 'Laphroaig', affinity: 0.9 }, seeds: ['Lagavulin'], from_call: 4 })
    expect(html).toContain('a 12 year Ardbeg')
    expect(html).toContain('A T shirt, for him')
    const text = html.replace(/<[^>]*>/g, ' ')
    expect(text).not.toMatch(/\p{L}[\u2010-\u2015]\p{L}/u)
    expect(text).not.toMatch(/12-year|T-shirt/)
  })
})
