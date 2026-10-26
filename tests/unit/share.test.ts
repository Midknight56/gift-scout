import { describe, expect, it } from 'vitest'
import { previewFor } from '../../src/app/share'
import type { ScoutEvent } from '../../src/agent/events'

const run = (said: string): ScoutEvent => ({ t: 'run', conversation: 'abc123', turn: 1, mode: 'replay', said })
const cards = (...gifts: string[]): ScoutEvent => ({
  t: 'cards',
  cards: gifts.map((gift, i) => ({
    id: `c${i + 1}`, gift, why: '', price_low: 0, price_high: 0,
    entity: { id: `e${i + 1}`, name: gift, type: 'brand' }, seeds: [], from_call: 1,
  })),
  dropped: [],
})

describe('previewFor', () => {
  it('uses the first message and cuts the title at a word boundary under 70 characters', () => {
    const preview = previewFor([[run('A thoughtful gift for someone who loves long and winding adventures across distant mountains')]])
    expect(preview.title).toBe('Gift Scout: A thoughtful gift for someone who loves long and...')
    expect(preview.title.length).toBeLessThanOrEqual(70)
  })

  it('lists the first three gifts from the last turn that has cards', () => {
    const preview = previewFor([[run('For my sister') , cards('Old book')], [run('She also likes music'), cards('A record', 'A concert', 'A speaker', 'Extra')]])
    expect(preview.description).toBe('Ideas: A record, A concert, A speaker')
  })

  it('uses the fallback description when there are no cards', () => {
    expect(previewFor([[run('For my friend')]]).description)
      .toBe('Gift ideas from what a person already loves, through Qloo.')
  })

  it('returns message markup as plain text', () => {
    expect(previewFor([[run('<script>alert(1)</script>')]]).title).toBe('Gift Scout: <script>alert(1)</script>')
  })
})
