import { describe, expect, it } from 'vitest'
import {
  dailyNeuronShare, DEFAULT_ACCOUNT_NEURONS, DEFAULT_DAILY_NEURONS, EXTRA_DAILY_NEURONS,
  JUDGING_DAILY_NEURONS,
} from '../../src/limits'

describe('daily neuron share', () => {
  it('uses the default share just before judging starts', () => {
    expect(dailyNeuronShare(Date.parse('2026-11-02T04:59:59.999Z'))).toBe(DEFAULT_DAILY_NEURONS)
  })

  it('uses the judging share when judging starts', () => {
    expect(dailyNeuronShare(Date.parse('2026-11-02T05:00:00Z'))).toBe(JUDGING_DAILY_NEURONS)
  })

  it('uses the judging share just before judging ends', () => {
    expect(dailyNeuronShare(Date.parse('2026-11-06T04:44:59.999Z'))).toBe(JUDGING_DAILY_NEURONS)
  })

  it('uses the default share when judging ends', () => {
    expect(dailyNeuronShare(Date.parse('2026-11-06T04:45:00Z'))).toBe(DEFAULT_DAILY_NEURONS)
  })

  it('uses the default share on 25 October 2026', () => {
    expect(dailyNeuronShare(Date.parse('2026-10-25T12:00:00Z'))).toBe(DEFAULT_DAILY_NEURONS)
  })

  it('keeps the judging shares under the account and free plan caps', () => {
    expect(JUDGING_DAILY_NEURONS + 700 + 700 + 2000 + 1500).toBeLessThanOrEqual(DEFAULT_ACCOUNT_NEURONS)
    expect(DEFAULT_ACCOUNT_NEURONS).toBeLessThan(10000)
  })
})

describe('extra share window', () => {
  it('uses 7000 at 2026-11-12T23:00:00Z', () => {
    expect(dailyNeuronShare(Date.parse('2026-11-12T23:00:00Z'))).toBe(7000)
  })

  it('uses 7000 at 2026-11-10T00:00:00Z', () => {
    expect(dailyNeuronShare(Date.parse('2026-11-10T00:00:00Z'))).toBe(7000)
  })

  it('uses 2000 at 2026-11-13T06:00:00Z', () => {
    expect(dailyNeuronShare(Date.parse('2026-11-13T06:00:00Z'))).toBe(2000)
  })

  it('uses 2000 at 2026-11-13T05:00:00Z (the end is exclusive)', () => {
    expect(dailyNeuronShare(Date.parse('2026-11-13T05:00:00Z'))).toBe(2000)
  })

  it('uses 2000 at 2026-11-09T23:59:59.999Z', () => {
    expect(dailyNeuronShare(Date.parse('2026-11-09T23:59:59.999Z'))).toBe(2000)
  })

  it('uses 3500 at 2026-12-02T12:00:00Z', () => {
    expect(dailyNeuronShare(Date.parse('2026-12-02T12:00:00Z'))).toBe(3500)
  })

  it('keeps the extra share under the account and free plan caps', () => {
    expect(EXTRA_DAILY_NEURONS + 1003).toBeLessThanOrEqual(DEFAULT_ACCOUNT_NEURONS)
    expect(DEFAULT_ACCOUNT_NEURONS).toBeLessThan(10000)
  })
})
