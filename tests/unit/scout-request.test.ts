import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const submit = source.slice(source.indexOf('async function submitMessage('), source.indexOf('/** The ship to fields'))
const ownerFor = source.slice(source.indexOf('function ownerFor('), source.indexOf('const calls = new Map()'))

describe('scout requests from the page', () => {
  it.each([null, 'owner-token'])('sends a conversation only when this tab owns it: %s', async (token) => {
    const bodies: unknown[] = []
    const send = { disabled: false, querySelector: () => ({ textContent: '' }) }
    await runInNewContext(`${ownerFor}\n${submit}\nsubmitMessage('Cheaper please')`, {
      conversation: 'shared123', busy: false,
      empty: {}, examples: {}, input: {}, send,
      chat: { querySelector: () => null }, walkPanel: { querySelectorAll: () => [] }, addLine: () => {}, readEvents: async () => {},
      sessionStorage: { getItem: () => token },
      fetch: async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body))
        return { ok: true, body: {} }
      },
    })
    expect(bodies).toEqual([token ? { message: 'Cheaper please', conversation: 'shared123', owner: token } : { message: 'Cheaper please' }])
  })
})
