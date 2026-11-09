import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8')
const helpers = app.slice(app.indexOf('function interestFor('), app.indexOf('function leaveOutResult('))

describe('leave this out', () => {
  it('names the typed interest behind a seed from the lookup that found it', () => {
    const calls = new Map([
      [1, { call: { tool: 'search_entities', args: { query: 'single malt', type: 'brand' } }, result: { ok: true, top: [{ name: 'Lagavulin' }] } }],
      [2, { call: { tool: 'search_entities', args: { query: 'John le Carre' } }, result: { ok: true, top: [{ name: 'John le Carré' }] } }],
    ])
    const context: Record<string, unknown> = { calls }
    runInNewContext(`${helpers}\nthis.interestFor = interestFor; this.leaveOutLabel = leaveOutLabel`, context)
    const interestFor = context.interestFor as (seed: string) => string
    const leaveOutLabel = context.leaveOutLabel as (seed: string) => string
    expect(interestFor('Lagavulin')).toBe('single malt')
    expect(interestFor('Unknown')).toBe('Unknown')
    expect(leaveOutLabel('Lagavulin')).toBe('Leave out single malt (Lagavulin)')
    expect(leaveOutLabel('John le Carré')).toBe('Leave out John le Carre (John le Carré)')
  })

  it('sends the drop words through the normal message path, owner only, never on a share page', () => {
    expect(app).toMatch(/submitMessage\(`Drop \$\{/)
    const draw = app.slice(app.indexOf('function drawLeaveOut('), app.indexOf('function interestFor('))
    expect(draw).toContain('canBuy')
    expect(draw).toContain('ownerFor(conversation)')
    expect(draw).toContain('data-leave-out')
    expect(app).toContain("aria-label=\"Leave an interest out\"")
  })

  it('shows what was left out and which cards were withdrawn, with no claim of a controlled test', () => {
    const block = app.slice(app.indexOf('function leaveOutResult('), app.indexOf('function drawCards('))
    expect(block).toContain("'leave-out-result'")
    expect(block).toContain('Left out ')
    expect(block).toContain('Withdrawn: ')
    expect(app).toMatch(/case 'cards_withdrawn': \{[\s\S]{0,200}leaveOutResult\(/)
    expect(app).not.toMatch(/\b(proves|experiment|causes)\b/i)
  })

  it('wraps the buttons at phone width with room around them', () => {
    expect(css).toMatch(/\.leave-out-row \{[^}]*flex-wrap: wrap[^}]*gap: 12px/)
    expect(css).toMatch(/\.leave-out \{[^}]*padding: 8px/)
  })

  it('draws the buttons enabled even when they appear during a running turn', () => {
    const draw = app.slice(app.indexOf('function drawLeaveOut('), app.indexOf('function interestFor('))
    expect(draw).not.toContain('disabled')
    const submit = app.slice(app.indexOf('async function submitMessage('), app.indexOf('/** The ship to fields'))
    expect(submit).toMatch(/finally \{[\s\S]*\.leave-out[\s\S]*disabled = false/)
  })
})
