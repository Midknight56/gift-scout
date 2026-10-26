/// <reference types="@cloudflare/workers-types" />
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import worker, { D1Samples, LayeredCache, recordedRunsFromD1, type Env } from '../../src/worker'
import { newState } from '../../src/agent/agent'
import { ownerToken } from '../../src/app/buy'
import { EXAMPLES } from '../../src/app/scout'
import { DEFAULT_DAILY_NEURONS, DEFAULT_ACCOUNT_NEURONS } from '../../src/limits'
import { channel3Enabled } from '../../src/channel3/flag'
import { Conversations, D1Cache } from '../../src/store/d1'
import { FakeD1 } from './fake-d1'

const databases: FakeD1[] = []
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const db of databases.splice(0)) db.close()
})

function setup(take = true, extra: Partial<Env> = {}) {
  const db = new FakeD1()
  const ledger = new FakeD1()
  databases.push(db, ledger)
  const env = {
    DB: db, LEDGER: ledger, ASSETS: { fetch: async () => new Response('<html>asset page</html>', { headers: { 'Content-Type': 'text/html' } }) },
    COUNTERS: { idFromName: (name: string) => name, get: () => ({ take: async () => take }) },
    SESSION_SECRET: 'test', ...extra,
  } as unknown as Env
  const pending: Promise<unknown>[] = []
  let counterCalls = 0
  const counters = { idFromName: (name: string) => name, get: () => ({ take: async () => { counterCalls++; return take } }) }
  Object.assign(env, { COUNTERS: counters })
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } } as unknown as ExecutionContext
  return { db, ledger, env, ctx, pending, get counterCalls() { return counterCalls } }
}

async function call(path: string, init: RequestInit = {}, harness = setup()) {
  const response = await worker.fetch(new Request('https://gift.test' + path, init), harness.env, harness.ctx)
  return response
}

async function stream(path: string, body: unknown, harness = setup(), headers: HeadersInit = {}) {
  const response = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) }, body: JSON.stringify(body) }, harness)
  // Drain while waitUntil runs: TransformStream applies backpressure, so the worker promise can finish only as
  // the response reader accepts its events.
  const text = await response.text()
  await Promise.all(harness.pending)
  return { response, events: text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) }
}

describe('worker front door', () => {
  it('reads Qloo samples and recorded runs from D1', async () => {
    const h = setup()
    const key = 'https://api.test/v2/insights?signal.interests.entities=synthetic'
    const body = JSON.stringify({ results: { entities: [{ entity_id: '00000000-0000-4000-8000-000000000001' }] } })
    await h.db.prepare('INSERT INTO qloo_samples (key, body) VALUES (?, ?)').bind(key, body).run()
    const d1 = h.db as unknown as D1Database
    const layered = new LayeredCache(new D1Cache(h.db), new D1Samples(d1))
    expect(await layered.get(key)).toBe(body)

    const run = { recorded_at: '2026-01-01', turns: [], states: [{ said: [EXAMPLES[0]] }] }
    await h.db.prepare('INSERT INTO recorded_runs (example, run) VALUES (?, ?)').bind(EXAMPLES[0], JSON.stringify(run)).run()
    expect(await recordedRunsFromD1(d1)).toEqual([run])
  })

  it('keeps Channel3 disabled when its flag is absent', () => {
    expect(channel3Enabled({ CHANNEL3_API_KEY: 'test-key' })).toBe(false)
  })

  it('keeps Channel3 disabled when its flag is off', () => {
    expect(channel3Enabled({ CHANNEL3: 'off', CHANNEL3_API_KEY: 'test-key' })).toBe(false)
  })

  it('keeps Channel3 disabled when its key is absent', () => {
    expect(channel3Enabled({ CHANNEL3: 'on' })).toBe(false)
  })

  it('GET /health answers 200 ok', async () => {
    const response = await call('/health')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  it('GET /api/examples answers the three EXAMPLES', async () => {
    const response = await call('/api/examples')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ examples: EXAMPLES })
  })

  it('rejects a cross-site scout POST before starting work', async () => {
    const h = setup()
    const response = await call('/api/scout', { method: 'POST', headers: { Origin: 'https://elsewhere.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: EXAMPLES[0] }) }, h)
    expect(response.status).toBe(403)
    expect(h.pending).toHaveLength(0)
  })

  it('GET /api/scout answers 405', async () => {
    expect((await call('/api/scout')).status).toBe(405)
  })

  it('replays an example without live services and turns an unknown message off', async () => {
    const h = setup()
    const replay = {
      recorded_at: '2026-01-01T00:00:00Z',
      turns: [[{ t: 'run', conversation: 'old', turn: 1, mode: 'live', said: EXAMPLES[0] }, { t: 'cards', cards: [], dropped: [] }, { t: 'usage', model_calls: 1, neurons: 1 }]],
      states: [{ ...newState('old'), turn: 1, said: [EXAMPLES[0]] }],
    }
    await h.db.prepare('INSERT INTO recorded_runs (example, run) VALUES (?, ?)').bind(EXAMPLES[0], JSON.stringify(replay)).run()
    const example = await stream('/api/scout', { message: EXAMPLES[0] }, h)
    expect(example.events[0]).toMatchObject({ t: 'run', mode: 'replay' })
    expect(example.events[1]).toMatchObject({ t: 'owner', token: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(example.events.at(-1)).toMatchObject({ t: 'done' })
    const id = String(example.events[0].conversation)
    const saved = await new Conversations(h.db).get(id)
    expect(saved?.turns.flat().some((event) => event.t === 'owner')).toBe(false)
    const shared = await call(`/api/conversation/${id}`, {}, h)
    expect(JSON.stringify(await shared.json())).not.toContain(String((example.events[1] as { token: string }).token))
    const unknown = await stream('/api/scout', { message: 'A new message about my aunt' })
    expect(unknown.events[0]).toMatchObject({ t: 'run', mode: 'off' })
  })

  it('replays an example below the monthly floor and runs live at the floor', async () => {
    let aiCalls = 0
    const h = setup(true, {
      AI: { run: async () => { aiCalls++; return { response: 'I could use more detail.', usage: { prompt_tokens: 1, completion_tokens: 1 } } } } as never,
      QLOO_API_KEY: 'fake',
    })
    const replay = {
      recorded_at: '2026-01-01T00:00:00Z',
      turns: [[{ t: 'run', conversation: 'old', turn: 1, mode: 'live', said: EXAMPLES[0] }, { t: 'cards', cards: [], dropped: [] }]],
      states: [{ ...newState('old'), turn: 1, said: [EXAMPLES[0]] }],
    }
    await h.db.prepare('INSERT INTO recorded_runs (example, run) VALUES (?, ?)').bind(EXAMPLES[0], JSON.stringify(replay)).run()
    let qlooCalls = 0
    globalThis.fetch = (async () => { qlooCalls++; throw new Error('Qloo must not be called') }) as typeof fetch

    await h.db.prepare('INSERT INTO qloo_quota (id, remaining, at) VALUES (1, 2999, ?)').bind(new Date().toISOString()).run()
    const below = await stream('/api/scout', { message: EXAMPLES[0] }, h)
    expect(below.events[0]).toMatchObject({ t: 'run', mode: 'replay' })
    expect(qlooCalls).toBe(0)
    expect(aiCalls).toBe(0)

    await h.db.prepare('UPDATE qloo_quota SET remaining = 3000 WHERE id = 1').run()
    const atFloor = await stream('/api/scout', { message: EXAMPLES[0] }, h)
    expect(atFloor.events[0]).toMatchObject({ t: 'run', mode: 'live' })
    expect(aiCalls).toBeGreaterThan(0)
  })

  it('runs live again once Qloo\'s month has reset, even if the last reading was under the floor', async () => {
    let aiCalls = 0
    const h = setup(true, {
      AI: { run: async () => { aiCalls++; return { response: 'I could use more detail.', usage: { prompt_tokens: 1, completion_tokens: 1 } } } } as never,
      QLOO_API_KEY: 'fake',
    })
    globalThis.fetch = (async () => Response.json({ results: [] })) as typeof fetch
    await h.db.prepare('INSERT INTO qloo_quota (id, remaining, at, resets_at) VALUES (1, 2999, ?, ?)')
      .bind(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() - 1000).toISOString()).run()
    const after = await stream('/api/scout', { message: EXAMPLES[0] }, h)
    expect(after.events[0]).toMatchObject({ t: 'run', mode: 'live' })
    expect(aiCalls).toBeGreaterThan(0)
  })

  it('refuses an upstream Qloo call in allow when monthly remaining is 2,999', async () => {
    const h = setup(true, { QLOO_API_KEY: 'fake' })
    await h.db.prepare('INSERT INTO qloo_quota (id, remaining, at) VALUES (1, 2999, ?)').bind(new Date().toISOString()).run()
    let qlooCalls = 0
    globalThis.fetch = (async () => { qlooCalls++; return Response.json({ results: [] }) }) as typeof fetch
    const init = await call('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    }, h)
    const sid = init.headers.get('MCP-Session-Id')!
    const result = await call('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_entities', arguments: { query: 'Phoebe Bridgers', type: 'artist' } } }),
    }, h)
    expect(result.status).toBe(200)
    expect(qlooCalls).toBe(0)
  })

  it('makes no AI or Qloo calls at the app daily neuron cap', async () => {
    let aiCalls = 0
    const h = setup(true, { AI: { run: async () => { aiCalls++; throw new Error('AI must not run') } } as never, QLOO_API_KEY: 'fake' })
    h.ledger.insertCall('gift-scout', new Date().toISOString().slice(0, 10), DEFAULT_DAILY_NEURONS)
    let qlooCalls = 0
    globalThis.fetch = (async () => { qlooCalls++; throw new Error('Qloo must not run') }) as typeof fetch
    const { events } = await stream('/api/scout', { message: 'A new message about my aunt' }, h)
    expect(events[0]).toMatchObject({ t: 'run', mode: 'off' })
    expect(qlooCalls).toBe(0)
    expect(aiCalls).toBe(0)
  })

  it('makes no AI or Qloo calls at the shared account neuron cap', async () => {
    let aiCalls = 0
    const h = setup(true, { AI: { run: async () => { aiCalls++; throw new Error('AI must not run') } } as never, QLOO_API_KEY: 'fake' })
    h.ledger.insertCall('another-app', new Date().toISOString().slice(0, 10), DEFAULT_ACCOUNT_NEURONS)
    let qlooCalls = 0
    globalThis.fetch = (async () => { qlooCalls++; throw new Error('Qloo must not run') }) as typeof fetch
    const { events } = await stream('/api/scout', { message: 'A new message about my aunt' }, h)
    expect(events[0]).toMatchObject({ t: 'run', mode: 'off' })
    expect(qlooCalls).toBe(0)
    expect(aiCalls).toBe(0)
  })

  it('makes no AI calls when the visitor turn counter refuses the request', async () => {
    let aiCalls = 0
    const h = setup(false, { AI: { run: async () => { aiCalls++; throw new Error('AI must not run') } } as never, QLOO_API_KEY: 'fake' })
    const { events } = await stream('/api/scout', { message: 'A new message about my aunt' }, h)
    expect(aiCalls).toBe(0)
    expect(events[0]).toMatchObject({ t: 'run', mode: 'off' })
  })

  it('returns 503 when the PayPal webhook id is unset', async () => {
    const response = await call('/api/paypal/webhook', { method: 'POST', body: '{}' })
    expect(response.status).toBe(503)
  })

  it('streams the buying off events without calling PayPal when its keys are absent', async () => {
    const h = setup()
    const id = 'conv1234'
    await new Conversations(h.db).put(id, { ...newState(id), turn: 1, cards: [{ id: 't1c1', gift: 'A gift', why: 'Because', price_low: 10, price_high: 20, entity: { id: 'entity123', name: 'Gift', type: 'brand' }, seeds: ['music'], from_call: 1 }] }, [])
    let paypalCalls = 0
    globalThis.fetch = (async () => { paypalCalls++; throw new Error('PayPal must not be called') }) as typeof fetch
    const { events } = await stream('/api/buy', { conversation: id, card: 't1c1', owner: await ownerToken(id, 'test') }, h)
    expect(paypalCalls).toBe(0)
    expect(events).toMatchObject([{ t: 'run', mode: 'off', purpose: 'buy' }, { t: 'error', text: 'Buying is off right now. Nothing was charged.' }])
  })

  it('rejects buys without the conversation owner token before counters or PayPal', async () => {
    const h = setup(true, { AI: { run: async () => { throw new Error('model must not run') } } as never, PAYPAL_CLIENT_ID: 'id', PAYPAL_SECRET: 'secret' })
    const id = 'conv1234'
    await new Conversations(h.db).put(id, { ...newState(id), turn: 1, cards: [{ id: 't1c1', gift: 'A gift', why: 'Because', price_low: 10, price_high: 20, entity: { id: 'entity123', name: 'Gift', type: 'brand' }, seeds: ['music'], from_call: 1 }] }, [])
    let paypalCalls = 0
    globalThis.fetch = (async () => { paypalCalls++; throw new Error('PayPal must not be called') }) as typeof fetch
    const otherOwner = await ownerToken('other123', 'test')
    for (const owner of [undefined, 'wrong-token', otherOwner]) {
      const response = await call('/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: id, card: 't1c1', owner }) }, h)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'Only the person who started this conversation can buy from it.' })
    }
    expect(h.counterCalls).toBe(0)
    expect(paypalCalls).toBe(0)
  })

  it('GET /api/conversation/bad!id answers 404', async () => {
    expect((await call('/api/conversation/bad!id')).status).toBe(404)
  })

  it('serves the ASSETS page unchanged for an unknown share id', async () => {
    const response = await call('/s/unknown1')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<html>asset page</html>')
  })
})
