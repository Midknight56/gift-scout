import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Browser module has no declaration file.
import { orderRowHtml, paidRowHtml } from '../../public/render.js'

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
const buy = source.slice(source.indexOf('async function buyCard('), source.indexOf('/** "Changed my mind"'))

describe('review 1: incomplete payment messages', () => {
  it.each(['502', 'missing body', 'network'])('keeps the payment outcome unknown after %s', async (failure) => {
    const lines: string[] = []
    const button = { textContent: 'Pay', dataset: {}, setAttribute() {}, removeAttribute() {} }
    await runInNewContext(`${buy}\nbuyCard('t1c1', 'card', null, button)`, {
      busy: false, conversation: 'conv1234', cards: new Map([['t1c1', {}]]),
      readShipping: () => ({}), quoteFor: () => 30, ownerFor: () => 'owner',
      payCopy: () => ({ card: 'Pay' }), button,
      chat: { querySelectorAll: () => [] }, leavingForPayPal: false,
      fetch: async () => { if (failure === 'network') throw new Error('Failed to fetch'); return { ok: failure !== '502', body: null } },
      addLine: (_kind: string, text: string) => lines.push(text),
    })
    expect(lines[0]).toContain('We could not confirm the payment')
    expect(lines[0]).not.toContain('Nothing was charged')
  })

  it('labels a card order as waiting until the separate capture is confirmed', () => {
    const order = { method: 'card', gift: 'Gift', order_id: 'ORDER123', amount: '30.00' }
    expect(orderRowHtml(order)).toContain('Waiting for PayPal to confirm the payment')
    expect(orderRowHtml(order)).not.toContain('Paid with')
    expect(paidRowHtml({ ...order, capture_id: 'CAPTURE1', at: '2026-11-05' })).toContain('>paid<')
  })
})
