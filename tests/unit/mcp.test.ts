import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

import worker, { type Env } from '../../src/worker'
import { FakeD1 } from './fake-d1'

const databases: FakeD1[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup() {
  const db = new FakeD1()
  databases.push(db)
  const env = {
    DB: db, LEDGER: db, ASSETS: { fetch: async () => new Response('<html></html>') },
    COUNTERS: { idFromName: (name: string) => name, get: () => ({ take: async () => true }) }, SESSION_SECRET: 'test',
  } as unknown as Env
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext
  return { env, ctx }
}

async function post(message: unknown, headers: HeadersInit = {}, h = setup()) {
  const response = await worker.fetch(new Request('https://gift.test/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) }, body: JSON.stringify(message),
  }), h.env, h.ctx)
  return { response, body: await response.json() as { result?: Record<string, any>; error?: Record<string, unknown> } }
}

describe('worker /mcp route', () => {
  it('initializes, then lists exactly the three Qloo tools with its session header', async () => {
    const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })
    expect(initialized.response.status).toBe(200)
    const session = initialized.response.headers.get('MCP-Session-Id')
    expect(session).toBeTruthy()
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'MCP-Session-Id': session! })
    expect(listed.response.status).toBe(200)
    expect(listed.body.result?.tools.map((tool: { name: string }) => tool.name)).toEqual(['search_entities', 'search_tags', 'taste_insights'])
  })

  it('refuses an origin from another site with 403', async () => {
    const { response } = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { Origin: 'https://elsewhere.test' })
    expect(response.status).toBe(403)
  })

  it('returns a tool error for search_entities when Qloo has no API key', async () => {
    const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const session = initialized.response.headers.get('MCP-Session-Id')!
    const result = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_entities', arguments: { query: 'Neverheard Qzx 849' } } }, { 'MCP-Session-Id': session })
    expect(result.response.status).toBe(200)
    expect(result.body.result).toMatchObject({ isError: true, content: [{ type: 'text' }] })
    expect(result.body.error).toBeUndefined()
  })
})
