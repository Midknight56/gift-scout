import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('recording fixture trim', () => {
  it('keeps Qloo explainability shares for the cards', () => {
    const output = execFileSync('python', [resolve(process.cwd(), 'tools/record_samples.py'), '--self-test'], { encoding: 'utf8' })
    expect(output.trim()).toBe('trim preserves signal.interests.entities')
  })
})
