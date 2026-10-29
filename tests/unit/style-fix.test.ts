import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8')

function lastRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
  return matches.at(-1)?.[1] ?? ''
}

describe('style regressions', () => {
  it('keeps quiet button text visible on hover', () => {
    const rule = lastRule('.buy-button.quiet:hover')
    const background = rule.match(/(?:^|;)\s*background\s*:\s*([^;]+)\s*;?/i)?.[1]?.trim()

    expect(background).toBeTruthy()
    expect(background).not.toBe('var(--white)')
    expect(rule).toMatch(/border-color\s*:\s*var\(--accent\)/)
  })

  it('moves the closed mobile sheet fully below the floating pill', () => {
    const mobileRules = [...css.matchAll(/@media\s*\(max-width:\s*760px\)\s*\{([\s\S]*?)\n\}/g)]
    const lastMobileRule = mobileRules.at(-1)?.[1] ?? ''
    const closedSheet = lastMobileRule.match(/\.scene-panel:not\(\.open\)\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(closedSheet).toMatch(/transform\s*:\s*translateY\(100%\)/)
  })
})
