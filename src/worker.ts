// Gift Scout on Cloudflare Workers.
//   GET  /                       the page (static, from public/)
//   GET  /s/<id>                 the page, opened on a shared conversation
//   POST /api/scout              one turn of the agent, streamed as NDJSON (src/app/scout.ts)
//   GET  /api/conversation/<id>  a saved conversation, for share links
//   GET  /api/examples           the three example messages
//   POST /mcp                    the Qloo tools as an MCP server (Streamable HTTP, spec 2025-11-25), for any agent
//   GET  /health                 ok
import { DurableObject } from 'cloudflare:workers'
import { WorkersAiModel, type AiBinding } from './agent/model'
import { buyTurn, handleWebhook, ownerToken, paidReturn, parseBuy, parseRefund, refundPurchase, tokenMatchesOwner } from './app/buy'
import { compareTurn, parseCompare } from './app/compare'
import { EXAMPLES, ndjsonResponse, parseScout, scoutTurn, type RecordedRun } from './app/scout'
import { previewFor, sharePage } from './app/share'
import { PayPal } from './paypal/client'
import { McpServer } from './mcp/server'
import { QlooClient, type Cache } from './qloo/client'
import { Channel3Client } from './channel3/client'
import { channel3Enabled } from './channel3/flag'
import { qlooTools, type QlooContext } from './qloo/tools'
import { Conversations, D1Cache, NeuronLedger, RunCache } from './store/d1'
import { REPLAY_PACE_MS, DAILY_BUYS_PER_VISITOR, DAILY_COMPARES_PER_VISITOR, DAILY_QLOO_CALLS, DAILY_QLOO_CALLS_PER_VISITOR, DAILY_CHANNEL3_CALLS, DAILY_CHANNEL3_CALLS_PER_VISITOR, DAILY_TURNS_PER_VISITOR, DEFAULT_ACCOUNT_NEURONS, dailyNeuronShare, MAX_CALL_NEURONS, QLOO_MONTH_FLOOR } from './limits'

export interface Env {
  /** Unset means no live Qloo: only cached and recorded answers. */
  QLOO_API_KEY?: string
  CHANNEL3_API_KEY?: string
  CHANNEL3?: string
  SESSION_SECRET: string
  DB: D1Database
  /** The shared ledger of the hackathon apps' Workers AI use; this app's own DB when not bound. */
  LEDGER?: D1Database
  AI?: AiBinding
  ASSETS: Fetcher
  COUNTERS: DurableObjectNamespace<DailyCounter>
  DAILY_NEURONS?: string
  /** Set high in .dev.vars for local test runs; unset in production. */
  TURNS_PER_VISITOR?: string
  /** The shared PayPal sandbox app's keys (paypal-sandbox.local.txt); unset means buying is off. */
  PAYPAL_CLIENT_ID?: string
  PAYPAL_SECRET?: string
  PAYPAL_WEBHOOK_ID?: string
  /** "1" while tools/record_samples.py runs: Qloo is asked fresh, so the recording shows real Qloo times. */
  RECORDING?: string
  ACCOUNT_NEURONS?: string
}

/** A day's count under one name: the whole Worker, or one visitor. SQLite backed storage. */
export class DailyCounter extends DurableObject<Env> {
  async take(day: string, limit: number): Promise<boolean> {
    const saved = (await this.ctx.storage.get<{ day: string; used: number }>('c')) ?? { day, used: 0 }
    const used = saved.day === day ? saved.used : 0
    if (used + 1 > limit) return false
    await this.ctx.storage.put('c', { day, used: used + 1 })
    return true
  }
}

/** A visitor is a salted hash of their address, so no address is stored. */
async function visitorOf(request: Request, salt: string): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ip))
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The D1 cache first, then the answers recorded for the examples, so the examples work with no key. */
export class LayeredCache implements Cache {
  constructor(private primary: Cache, private samples: Cache) {}
  async get(key: string): Promise<string | null> {
    const hit = await this.primary.get(key)
    if (hit) return hit
    return this.samples.get(key)
  }
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> { return this.primary.put(key, value, opts) }
}

export class D1Samples implements Cache {
  constructor(private db: D1Database) {}
  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT body FROM qloo_samples WHERE key = ?').bind(key).first<{ body: string }>()
    return row?.body ?? null
  }
  async put(): Promise<void> {}
}

export async function recordedRunsFromD1(db: D1Database): Promise<RecordedRun[]> {
  const rows = await db.prepare('SELECT run FROM recorded_runs').all<{ run: string }>()
  return rows.results.map(({ run }) => JSON.parse(run) as RecordedRun)
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')
}

function today(): string { return new Date().toISOString().slice(0, 10) }

function counter(env: Env, name: string) { return env.COUNTERS.get(env.COUNTERS.idFromName(name)) }

async function qlooQuota(env: Env): Promise<number | null> {
  try {
    const row = await env.DB.prepare('SELECT remaining, resets_at FROM qloo_quota WHERE id = 1').first<{ remaining: number; resets_at: string | null }>()
    // Past Qloo's monthly reset the reading is stale; while under the floor no live call would ever refresh it.
    if (row?.resets_at && Date.parse(row.resets_at) <= Date.now()) return null
    return row?.remaining ?? null
  } catch { return null }
}

async function qlooFor(request: Request, env: Env, ctx?: ExecutionContext): Promise<QlooContext> {
  const visitor = await visitorOf(request, env.SESSION_SECRET)
  // Keep this client's newest observation immediately, while the shared D1 upsert runs in the background.
  let observedRemaining = await qlooQuota(env)
  const allow = async () => {
    const remaining = observedRemaining ?? await qlooQuota(env)
    if (remaining !== null && remaining < QLOO_MONTH_FLOOR) return false
    return (await counter(env, 'visitor:' + visitor).take(today(), DAILY_QLOO_CALLS_PER_VISITOR)) &&
      (await counter(env, 'qloo-total').take(today(), DAILY_QLOO_CALLS))
  }
  const cache = new LayeredCache(new D1Cache(env.DB), env.RECORDING === '1' ? { get: async () => null, put: async () => {} } : new D1Samples(env.DB))
  const onQuota = (remaining: number, resetSeconds?: number) => {
    observedRemaining = remaining
    const resetsAt = resetSeconds === undefined ? null : new Date(Date.now() + resetSeconds * 1000).toISOString()
    const update = env.DB.prepare('INSERT INTO qloo_quota (id, remaining, at, resets_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET remaining = excluded.remaining, at = excluded.at, resets_at = excluded.resets_at')
      .bind(remaining, new Date().toISOString(), resetsAt).run()
    if (ctx) ctx.waitUntil(update)
    else void update.catch(() => {})
  }
  // fetch is wrapped: Workers throw "Illegal invocation" when the global fetch is called detached.
  return { qloo: new QlooClient(env.QLOO_API_KEY ?? '', (input, init) => fetch(input, init), cache, allow, onQuota) }
}

function channel3For(request: Request, env: Env): Channel3Client | null {
  if (!channel3Enabled(env)) return null
  const visitorPromise = visitorOf(request, env.SESSION_SECRET)
  const allow = async () => {
    const visitor = await visitorPromise
    return (await counter(env, 'channel3:' + visitor).take(today(), DAILY_CHANNEL3_CALLS_PER_VISITOR)) &&
      (await counter(env, 'channel3:all').take(today(), DAILY_CHANNEL3_CALLS))
  }
  return new Channel3Client(env.CHANNEL3_API_KEY!, (input, init) => fetch(input, init), new D1Cache(env.DB), allow)
}

function paypalFor(env: Env): PayPal | null {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_SECRET) return null
  return new PayPal(env.PAYPAL_CLIENT_ID, env.PAYPAL_SECRET, (input, init) => fetch(input, init))
}

function ledgerFor(env: Env): NeuronLedger {
  return new NeuronLedger(env.LEDGER ?? env.DB, {
    app: 'gift-scout',
    dailyCap: Number(env.DAILY_NEURONS ?? dailyNeuronShare()),
    accountCap: Number(env.ACCOUNT_NEURONS ?? DEFAULT_ACCOUNT_NEURONS),
    reserve: MAX_CALL_NEURONS,
  })
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/health') return new Response('ok')

    if (path === '/api/examples') return json({ examples: EXAMPLES })

    if (path.startsWith('/api/conversation/')) {
      const id = decodeURIComponent(path.slice('/api/conversation/'.length))
      const saved = /^[A-Za-z0-9_-]{6,48}$/.test(id) ? await new Conversations(env.DB).get(id) : null
      return saved ? json({ turns: saved.turns }) : json({ error: 'Not found' }, 404)
    }

    if (path === '/api/scout') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
      const origin = request.headers.get('Origin')
      if (origin && origin !== url.origin) return json({ error: 'Origin not allowed' }, 403)
      const parsed = await parseScout(request)
      if (!parsed.ok) return json({ error: parsed.text }, parsed.status)
      const monthRemaining = await qlooQuota(env)
      const monthlyLimitReached = monthRemaining !== null && monthRemaining < QLOO_MONTH_FLOOR
      const visitor = await visitorOf(request, env.SESSION_SECRET)
      const budget = ledgerFor(env)
      const stream = ndjsonResponse()
      const work = scoutTurn(parsed.message, parsed.conversation, {
        conversations: new Conversations(env.DB),
        runs: new RunCache(env.DB),
        recorded: () => recordedRunsFromD1(env.DB),
        tools: qlooTools(),
        live: !monthlyLimitReached && env.QLOO_API_KEY && env.AI
          ? {
              model: new WorkersAiModel(env.AI), ctx: await qlooFor(request, env, ctx), budget,
              takeVisitorTurn: () => counter(env, 'turns:' + visitor).take(today(), Number(env.TURNS_PER_VISITOR ?? DAILY_TURNS_PER_VISITOR)),
            }
          : null,
        products: channel3For(request, env) ?? undefined,
        newId,
        ownerToken: (id) => ownerToken(id, env.SESSION_SECRET),
        paceMs: REPLAY_PACE_MS,
      }, stream.send)
        .catch(async () => { await stream.send({ t: 'error', text: 'Something broke on our side. Try again in a minute.' }) })
        .finally(() => stream.close())
      ctx.waitUntil(work)
      return stream.response
    }

    if (path === '/api/buy') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
      const origin = request.headers.get('Origin')
      if (origin && origin !== url.origin) return json({ error: 'Origin not allowed' }, 403)
      const parsed = await parseBuy(request)
      if (!parsed) return json({ error: 'Send a conversation and a card.' }, 400)
      if (!(await tokenMatchesOwner(parsed.conversation, parsed.owner, env.SESSION_SECRET))) return json({ error: 'Only the person who started this conversation can buy from it.' }, 403)
      const visitor = await visitorOf(request, env.SESSION_SECRET)
      const stream = ndjsonResponse()
      const work = buyTurn(parsed.conversation, parsed.card, {
        conversations: new Conversations(env.DB),
        paypal: paypalFor(env),
        live: env.AI
          ? { model: new WorkersAiModel(env.AI), budget: ledgerFor(env), takeVisitorBuy: () => counter(env, 'buys:' + visitor).take(today(), DAILY_BUYS_PER_VISITOR) }
          : null,
        origin: url.origin,
        ownerSecret: env.SESSION_SECRET,
      }, stream.send, parsed.method, parsed.owner, parsed.ship)
        .catch(async () => { await stream.send({ t: 'error', text: 'Something broke on our side. Check PayPal before trying again.' }) })
        .finally(() => stream.close())
      ctx.waitUntil(work)
      return stream.response
    }

    if (path === '/api/refund') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
      const origin = request.headers.get('Origin')
      if (origin && origin !== url.origin) return json({ error: 'Origin not allowed' }, 403)
      const parsed = await parseRefund(request)
      if (!parsed) return json({ error: 'Send a conversation and a card.' }, 400)
      const out = await refundPurchase(parsed, { conversations: new Conversations(env.DB), paypal: paypalFor(env), ownerSecret: env.SESSION_SECRET })
      return json(out.event ? { event: out.event } : { error: out.error }, out.status)
    }

    if (path === '/api/compare') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
      const origin = request.headers.get('Origin')
      if (origin && origin !== url.origin) return json({ error: 'Origin not allowed' }, 403)
      const parsed = await parseCompare(request)
      if (!parsed) return json({ error: 'Send a conversation.' }, 400)
      if (!(await tokenMatchesOwner(parsed.conversation, parsed.owner, env.SESSION_SECRET))) return json({ error: 'Only the person who started this conversation can compare it.' }, 403)
      const visitor = await visitorOf(request, env.SESSION_SECRET)
      const stream = ndjsonResponse()
      const work = compareTurn(parsed.conversation, {
        conversations: new Conversations(env.DB),
        live: env.AI && env.QLOO_API_KEY
          ? {
              model: new WorkersAiModel(env.AI), qloo: (await qlooFor(request, env, ctx)).qloo, budget: ledgerFor(env),
              takeVisitorCompare: () => counter(env, 'compares:' + visitor).take(today(), DAILY_COMPARES_PER_VISITOR),
            }
          : null,
      }, stream.send)
        .catch(async () => { await stream.send({ t: 'error', text: 'Something broke on our side. Try again in a minute.' }) })
        .finally(() => stream.close())
      ctx.waitUntil(work)
      return stream.response
    }

    if (path === '/paid') return paidReturn(url, { conversations: new Conversations(env.DB), paypal: paypalFor(env) })

    if (path === '/api/paypal/webhook') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
      if (!env.PAYPAL_WEBHOOK_ID) return json({ error: 'Webhook is not configured' }, 503)
      return handleWebhook(request, { conversations: new Conversations(env.DB), paypal: paypalFor(env), webhookId: env.PAYPAL_WEBHOOK_ID })
    }

    if (path === '/mcp') {
      const server = new McpServer<QlooContext>({
        info: { name: 'gift-scout', title: 'Gift Scout', version: '0.2.0', description: 'Gift ideas from what a person already loves, through Qloo.', websiteUrl: url.origin },
        instructions:
          'Resolve each thing the person loves with search_entities (or search_tags for a cuisine, hobby or genre), then ' +
          'call taste_insights with those ids for each kind of gift (brand, book, place with their city, podcast, ' +
          'destination). Every suggestion should name the affinity it came from.',
        tools: qlooTools(),
        secret: env.SESSION_SECRET,
        allowOrigin: (o) => o === url.origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o),
        context: (req) => qlooFor(req, env, ctx),
      })
      return server.handle(request)
    }

    const shareMatch = path.match(/^\/s\/([A-Za-z0-9_-]{6,48})\/?$/)
    if (shareMatch) {
      const saved = await new Conversations(env.DB).get(shareMatch[1])
      const page = await env.ASSETS.fetch(new Request(new URL('/', url), request))
      return saved ? sharePage(page, previewFor(saved.turns)) : page
    }
    return env.ASSETS.fetch(request)
  },
}
