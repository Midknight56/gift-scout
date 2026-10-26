import { afterEach, describe, expect, it } from 'vitest'
import { NeuronLedger } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const databases: FakeD1[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function ledger(opts: { app?: string; dailyCap?: number; accountCap?: number; reserve?: number; day?: string } = {}) {
  const db = new FakeD1()
  databases.push(db)
  return { db, value: new NeuronLedger(db, { app: opts.app ?? 'gift-scout', dailyCap: opts.dailyCap ?? 100, accountCap: opts.accountCap ?? 200, reserve: opts.reserve, day: () => opts.day ?? '2026-10-23' }) }
}

describe('NeuronLedger', () => {
  it('allows spend under both caps and applies the daily cap only to this app', async () => {
    const { db, value } = ledger({ accountCap: 300 })
    db.insertCall('other-app', '2026-10-23', 190)
    expect(await value.allow()).toBe(true)
    db.insertCall('gift-scout', '2026-10-23', 100)
    expect(await value.allow()).toBe(false)
  })

  it('denies spend when all apps reach the account cap', async () => {
    const { db, value } = ledger()
    db.insertCall('other-app', '2026-10-23', 200)
    expect(await value.allow()).toBe(false)
  })

  it('reserves the next call against the app cap', async () => {
    const { db, value } = ledger({ dailyCap: 100, accountCap: 200, reserve: 50 })
    db.insertCall('gift-scout', '2026-10-23', 51)
    expect(await value.allow()).toBe(false)
    const boundary = ledger({ dailyCap: 100, accountCap: 200, reserve: 50 })
    boundary.db.insertCall('gift-scout', '2026-10-23', 50)
    expect(await boundary.value.allow()).toBe(true)
  })

  it('reserves the next call against the account cap', async () => {
    const { db, value } = ledger({ dailyCap: 200, accountCap: 100, reserve: 50 })
    db.insertCall('other-app', '2026-10-23', 51)
    expect(await value.allow()).toBe(false)
    const boundary = ledger({ dailyCap: 200, accountCap: 100, reserve: 50 })
    boundary.db.insertCall('other-app', '2026-10-23', 50)
    expect(await boundary.value.allow()).toBe(true)
  })

  it('does not count a row from yesterday', async () => {
    const { db, value } = ledger()
    db.insertCall('gift-scout', '2026-10-22', 100)
    db.insertCall('other-app', '2026-10-22', 200)
    expect(await value.allow()).toBe(true)
  })

  it('a call that costs more than its reserve settles at its real cost and the cap counts it', async () => {
    const { db, value } = ledger({ dailyCap: 100, accountCap: 200, reserve: 50 })
    const held = await value.reserve()
    expect(held).not.toBeNull()
    await held!.settle(60)
    const row = await db.prepare('SELECT neurons FROM ai_calls').bind().first<{ neurons: number }>()
    expect(row?.neurons).toBe(60)
    expect((await value.spentToday()).app).toBe(60)
    // 60 + 50 is over 100: a settle capped down to the reserve would have left room for this call.
    expect(await value.reserve()).toBeNull()
  })

  it('settle replaces the reserved amount', async () => {
    const { db, value } = ledger({ day: '2026-10-23' })
    const held = await value.reserve()
    expect(held).not.toBeNull()
    await held!.settle(12.5)
    const row = await db.prepare('SELECT app, day, neurons FROM ai_calls').bind().first<{ app: string; day: string; neurons: number }>()
    expect(row).toEqual({ app: 'gift-scout', day: '2026-10-23', neurons: 12.5 })
  })

  it('two calls at the same time cannot both pass the cap', async () => {
    const { db, value } = ledger({ dailyCap: 2000, accountCap: 5000, reserve: 50 })
    db.insertCall('gift-scout', '2026-10-23', 1940)
    const held = await Promise.all([value.reserve(), value.reserve()])
    expect(held.filter(Boolean)).toHaveLength(1)
    expect(held.filter((item) => item === null)).toHaveLength(1)
    await held.find(Boolean)!.settle(30)
    const row = await db.prepare('SELECT COALESCE(SUM(neurons),0) AS total FROM ai_calls WHERE day = ? AND app = ?').bind('2026-10-23', 'gift-scout').first<{ total: number }>()
    expect(row?.total).toBe(1970)
  })

  it('two calls at the same time cannot both pass the account cap', async () => {
    const { db, value } = ledger({ dailyCap: 5000, accountCap: 2000, reserve: 50 })
    db.insertCall('other-app', '2026-10-23', 1940)
    const held = await Promise.all([value.reserve(), value.reserve()])
    expect(held.filter(Boolean)).toHaveLength(1)
    expect(held.filter((item) => item === null)).toHaveLength(1)
    await held.find(Boolean)!.settle(30)
    const row = await db.prepare('SELECT COALESCE(SUM(neurons),0) AS total FROM ai_calls WHERE day = ?').bind('2026-10-23').first<{ total: number }>()
    expect(row?.total).toBe(1970)
  })

  it('a reservation nobody settles stays counted at the reserve', async () => {
    const { db, value } = ledger({ reserve: 25 })
    expect(await value.reserve()).not.toBeNull()
    const row = await db.prepare('SELECT COALESCE(SUM(neurons),0) AS total FROM ai_calls').bind().first<{ total: number }>()
    expect(row?.total).toBe(25)
  })
})
