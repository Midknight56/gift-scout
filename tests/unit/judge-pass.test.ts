/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))
import worker, { type Env } from '../../src/worker'
import { ownerToken } from '../../src/app/buy'
import { dailyNeuronShare, perVisitor, publicLimit, visitorLimit, JUDGE_TURNS, JUDGE_BUYS, JUDGE_COMPARES, DAILY_COMPARES_PER_VISITOR } from '../../src/limits'

const env = { SESSION_SECRET: 'test', JUDGE_PASS: 'private pass', ASSETS: { fetch: async () => new Response('asset') } } as unknown as Env
const call = (path: string, extra: Partial<Env> = {}) => worker.fetch(new Request('https://gift.test' + path), { ...env, ...extra }, {} as ExecutionContext)

describe('access pass', () => {
  it('refuses a wrong or missing pass without a cookie', async () => {
    for (const path of ['/judge?pass=wrong', '/judge']) {
      const response = await call(path)
      expect(response.status).toBe(403)
      expect(response.headers.get('Set-Cookie')).toBeNull()
      expect(await response.text()).toContain('That pass is not right.')
    }
  })
  it('sets a signed cookie and returns home', async () => {
    const response = await call('/judge?pass=private%20pass')
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/')
    expect(response.headers.get('Set-Cookie')).toBe(`gs_judge=${await ownerToken('judge-v1', 'test')}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`)
  })
  it('returns 404 when no pass is configured', async () => {
    const response = await call('/judge?pass=private%20pass', { JUDGE_PASS: undefined })
    expect(response.status).toBe(404)
    expect(response.headers.get('Set-Cookie')).toBeNull()
  })
})

describe('December room', () => {
  it('uses December boundaries and preserves November boundaries', () => {
    for (const [at, share, visitor] of [
      ['2026-12-01T04:59:59.999Z', 2000, 12],
      ['2026-12-01T05:00:00Z', 3500, 48],
      ['2026-12-10T12:00:00Z', 3500, 48],
      ['2026-12-15T23:00:00Z', 3500, 48],
      ['2026-12-16T04:59:59.999Z', 3500, 48],
      ['2026-12-16T05:00:00Z', 2000, 12],
      ['2026-12-20T12:00:00Z', 2000, 12],
      ['2026-11-20T12:00:00Z', 2000, 12],
      ['2026-11-02T00:00:00Z', 2000, 48],
      ['2026-11-02T05:00:00Z', 3500, 48],
      ['2026-11-06T04:45:00Z', 2000, 48],
      ['2026-11-06T12:00:00Z', 2000, 12],
    ] as const) {
      expect(dailyNeuronShare(Date.parse(at)), at).toBe(share)
      expect(perVisitor(12, Date.parse(at)), at).toBe(visitor)
    }
  })
})

describe('reserved caps', () => {
  it('keeps room inside the window and restores normal caps outside it', () => {
    const inside = Date.parse('2026-12-10T12:00:00Z')
    const outside = Date.parse('2026-12-20T12:00:00Z')
    for (const [total, reserve] of [[3500, 1000], [2000, 300], [300, 50]]) {
      expect(publicLimit(total, reserve, false, inside)).toBe(total - reserve)
      expect(publicLimit(total, reserve, true, inside)).toBe(total)
      expect(publicLimit(total, reserve, false, outside)).toBe(total)
      expect(publicLimit(total, reserve, true, outside)).toBe(total)
    }
    for (const [normal, signed] of [[12, JUDGE_TURNS], [6, JUDGE_BUYS], [DAILY_COMPARES_PER_VISITOR, JUDGE_COMPARES], [150, 600], [30, 120]]) {
      expect(visitorLimit(normal, true, signed, inside)).toBe(signed)
      expect(visitorLimit(normal, false, signed, inside)).toBe(normal * 4)
      expect(visitorLimit(normal, true, signed, outside)).toBe(normal)
      expect(visitorLimit(normal, false, signed, outside)).toBe(normal)
    }
  })

  it('allows 6 daily compares per visitor in normal times', () => {
    expect(DAILY_COMPARES_PER_VISITOR).toBe(6)
  })
})
