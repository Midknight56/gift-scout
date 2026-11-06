import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const ownerFor = source.slice(source.indexOf('function ownerFor('), source.indexOf('const calls = new Map()'))
const compare = source.slice(source.indexOf('async function compareWithQlooOff('), source.indexOf('/** The tap on "Buy this one"'))

async function invoke(comparisonReceived: boolean) {
  const button = { disabled: false, textContent: 'Compare with Qloo off' }
  const lines: string[][] = []
  await runInNewContext(`${ownerFor}\n${compare}\nasync function readEvents() { if (${comparisonReceived}) comparisonExists = true; else addLine('error-line', 'stream failure'); }\ncompareWithQlooOff(button)`, {
    busy: false, conversation: 'shared123', comparisonExists: false,
    sessionStorage: { getItem: () => 'owner-token' },
    fetch: async () => ({ ok: true, body: {} }),
    addLine: (...args: string[]) => { lines.push(args) }, button,
  })
  return { button, lines }
}

describe('compare button after a stream', () => {
  it('restores its old label when the stream ends without a comparison', async () => {
    const { button, lines } = await invoke(false)
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Compare with Qloo off')
    expect(lines).toEqual([['error-line', 'stream failure']])
  })

  it('keeps the completed comparison state', async () => {
    const { button } = await invoke(true)
    // drawComparison removes the compare action, while the page keeps the completed comparison state.
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Comparing')
  })
})
