// MCP Streamable HTTP transport (2025-11-25) for Workers. JSON responses only, no SSE stream; sessions are
// stateless HMAC-signed ids.
import { validate, type JsonSchema } from './schema'

export const LATEST_VERSION = '2025-11-25'
export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const
const SESSION_HOURS = 24

export interface ContentText { type: 'text'; text: string }
export interface ToolResult {
  content: ContentText[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface Tool<C> {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
  run(args: Record<string, unknown>, ctx: C): Promise<ToolResult>
}

export interface ServerOptions<C> {
  info: { name: string; title: string; version: string; description?: string; websiteUrl?: string }
  instructions?: string
  tools: Tool<C>[]
  /** HMAC key for session ids. */
  secret: string
  /** Requests without an Origin header are always allowed. */
  allowOrigin(origin: string): boolean
  /** Throw to reject the request. */
  context(request: Request): Promise<C>
  now?: () => number
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
interface RpcRequest { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

const ERR = { parse: -32700, invalidRequest: -32600, method: -32601, params: -32602, internal: -32603 }

export class McpServer<C> {
  constructor(private o: ServerOptions<C>) {}

  async handle(request: Request): Promise<Response> {
    const origin = request.headers.get('Origin')
    if (origin && !this.o.allowOrigin(origin)) return rpcError(403, null, ERR.invalidRequest, 'Origin not allowed')
    const cors = origin ? corsHeaders(origin) : {}
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method === 'GET') return new Response('This server does not offer a server to client stream.', { status: 405, headers: { Allow: 'POST, DELETE', ...cors } })
    if (request.method === 'DELETE') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE', ...cors } })
    const res = await this.post(request)
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
    return res
  }

  private async post(request: Request): Promise<Response> {
    let body: unknown
    try { body = await request.json() } catch { return rpcError(400, null, ERR.parse, 'Body is not JSON') }
    if (Array.isArray(body)) return rpcError(400, null, ERR.invalidRequest, 'Batches are not part of this protocol version')
    const msg = body as RpcRequest
    if (!msg || msg.jsonrpc !== '2.0') return rpcError(400, null, ERR.invalidRequest, 'Not a JSON-RPC 2.0 message')

    // Notifications and responses get a bare 202.
    if (msg.method === undefined || msg.id === undefined) {
      if (msg.method === undefined && msg.result === undefined && msg.error === undefined) return rpcError(400, null, ERR.invalidRequest, 'Empty message')
      return new Response(null, { status: 202 })
    }

    const id = msg.id
    if (msg.method === 'initialize') return this.initialize(id, msg.params ?? {})

    const version = request.headers.get('MCP-Protocol-Version')
    if (version && !(SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
      return rpcError(400, id, ERR.invalidRequest, 'Unsupported MCP-Protocol-Version: ' + version)
    }
    const sid = request.headers.get('MCP-Session-Id')
    if (!sid) return rpcError(400, id, ERR.invalidRequest, 'Missing MCP-Session-Id: send initialize first')
    if (!(await this.sessionValid(sid))) return rpcError(404, id, ERR.invalidRequest, 'Session not found or expired: send initialize again')

    if (msg.method === 'ping') return rpcOk(id, {})
    if (msg.method === 'tools/list') return rpcOk(id, { tools: this.o.tools.map(listing) })
    if (msg.method === 'tools/call') return this.call(request, id, msg.params ?? {})
    return rpcError(200, id, ERR.method, 'Method not found: ' + msg.method)
  }

  private async initialize(id: string | number | null, params: Record<string, unknown>): Promise<Response> {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_VERSION
    const version = (SUPPORTED_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_VERSION
    const sid = await this.newSession()
    const result = {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.o.info,
      ...(this.o.instructions ? { instructions: this.o.instructions } : {}),
    }
    const res = rpcOk(id, result)
    res.headers.set('MCP-Session-Id', sid)
    return res
  }

  private async call(request: Request, id: string | number | null, params: Record<string, unknown>): Promise<Response> {
    const name = params.name
    const tool = this.o.tools.find((t) => t.name === name)
    if (!tool) return rpcError(200, id, ERR.params, 'Unknown tool: ' + String(name))
    const args = (params.arguments ?? {}) as Record<string, unknown>
    const problems = validate(tool.inputSchema, args)
    if (problems.length) {
      return rpcOk(id, { content: [{ type: 'text', text: 'Those arguments do not fit: ' + problems.join('; ') }], isError: true })
    }
    let ctx: C
    try { ctx = await this.o.context(request) } catch (e) {
      return rpcOk(id, { content: [{ type: 'text', text: (e as Error).message }], isError: true })
    }
    try {
      const result = await tool.run(args, ctx)
      return rpcOk(id, result as unknown as Json)
    } catch (e) {
      return rpcOk(id, { content: [{ type: 'text', text: 'Something went wrong on our side: ' + (e as Error).message }], isError: true })
    }
  }

  private async newSession(): Promise<string> {
    const now = (this.o.now ?? Date.now)()
    const rnd = crypto.getRandomValues(new Uint8Array(12))
    const payload = b64url(new TextEncoder().encode(JSON.stringify({ t: now, r: b64url(rnd) })))
    return payload + '.' + (await sign(this.o.secret, payload))
  }

  private async sessionValid(sid: string): Promise<boolean> {
    const [payload, mac] = sid.split('.')
    if (!payload || !mac) return false
    if ((await sign(this.o.secret, payload)) !== mac) return false
    try {
      const { t } = JSON.parse(new TextDecoder().decode(unb64url(payload))) as { t: number }
      return (this.o.now ?? Date.now)() - t < SESSION_HOURS * 3600_000
    } catch { return false }
  }
}

function listing<C>(t: Tool<C>) {
  return {
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }
}

function rpcOk(id: string | number | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function rpcError(status: number, id: string | number | null, code: number, message: string): Response {
  const body = id === null ? { jsonrpc: '2.0', error: { code, message } } : { jsonrpc: '2.0', id, error: { code, message } }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, MCP-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'MCP-Session-Id',
    Vary: 'Origin',
  }
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))))
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
