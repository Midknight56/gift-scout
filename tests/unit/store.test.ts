import { afterEach, describe, expect, it } from 'vitest'
import { Conversations, D1Cache, NeuronLedger, normalizeRequest, runKey } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'
import { newState } from '../../src/agent/agent'
import type { ScoutEvent } from '../../src/agent/events'

const databases: FakeD1[] = []
function db(): FakeD1 { const value = new FakeD1(); databases.push(value); return value }
afterEach(() => { for (const value of databases.splice(0)) value.close() })

describe('D1 storage', () => {
  it('returns cached bodies until expiry', async () => {
    const database = db()
    let now = 1000
    const cache = new D1Cache(database, () => now)
    await cache.put('k', 'body', { expirationTtl: 2 })
    expect(await cache.get('k')).toBe('body')
    now += 2001
    expect(await cache.get('k')).toBeNull()
  })

  it('round trips conversations and replaces existing values', async () => {
    const conversations = new Conversations(db(), () => 123)
    const state = newState('c1')
    const turns: ScoutEvent[][] = [[{ t: 'say', text: 'hello' }]]
    await conversations.put('c1', state, turns)
    expect(await conversations.get('c1')).toEqual({ state, turns })
    const replacement = newState('c1')
    replacement.turn = 2
    const nextTurns: ScoutEvent[][] = [[{ t: 'error', text: 'new' }]]
    await conversations.put('c1', replacement, nextTurns)
    expect(await conversations.get('c1')).toEqual({ state: replacement, turns: nextTurns })
  })

  it('enforces app and account caps and resets on a new day', async () => {
    const database = db()
    let day = '2026-10-22'
    const ledger = new NeuronLedger(database, { app: 'store', dailyCap: 10, accountCap: 20, reserve: 1, day: () => day })
    expect(await ledger.allow()).toBe(true)
    const first = await ledger.reserve()
    await first!.settle(9)
    expect(await ledger.allow()).toBe(true)
    const second = await ledger.reserve()
    await second!.settle(1)
    expect(await ledger.allow()).toBe(false)
    day = '2026-10-23'
    expect(await ledger.allow()).toBe(true)
    database.insertCall('other', day, 20)
    expect(await ledger.allow()).toBe(false)
    expect(await ledger.spentToday()).toEqual({ app: 0, all: 20 })
  })

  it('normalizes requests and creates stable run keys', async () => {
    const a = 'My sister.  She loves Phoebe Bridgers!'
    const b = 'my sister she loves phoebe bridgers'
    expect(normalizeRequest(a)).toBe(normalizeRequest(b))
    expect(await runKey(a)).toBe(await runKey(b))
    expect(await runKey(a)).toMatch(/^run:[0-9a-f]{64}$/)
  })
})
