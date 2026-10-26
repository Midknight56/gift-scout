// POST /api/buy   the "Buy this one" tap: one buy turn of the agent, streamed like a scout turn, ending in an order.
// GET  /paid      PayPal sends the buyer back here after approval: the order is captured and the conversation shows it.
import type { Budget, ConversationState } from '../agent/agent'
import { runBuyTurn, type PayMethod, type Purchase } from '../agent/buy'
import type { ScoutEvent } from '../agent/events'
import type { Model } from '../agent/model'
import { PayPalError, type PayPal } from '../paypal/client'
import { parseEvent } from '../paypal/webhook'
import type { Conversations } from '../store/d1'

type State = ConversationState & { purchases?: Purchase[] }
// Orders in flight in this isolate. Across isolates the capture's PayPal-Request-Id (PayPal answers a repeat with the
// same capture) and the fresh read before markPaid keep it to one paid row.
const orderLocks = new Map<string, Promise<void>>()
const MAX_WEBHOOK_BYTES = 100 * 1024

async function withOrderLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = orderLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  orderLocks.set(key, current)
  await previous
  try { return await action() } finally {
    release()
    if (orderLocks.get(key) === current) orderLocks.delete(key)
  }
}

function sameAmount(left: string, right: string): boolean {
  const cents = (value: string) => {
    const amount = Number(value)
    return Number.isFinite(amount) && Math.round(amount * 100)
  }
  return cents(left) === cents(right)
}

function markPaid(saved: { state: ConversationState; turns: ScoutEvent[][] }, purchase: Purchase, orderId: string, captureId: string, amount: string, now: () => number): { state: State; turns: ScoutEvent[][] } {
  const state = saved.state as State
  if (saved.turns.flat().some((event) => event.t === 'paid' && (event.order_id === orderId || event.capture_id === captureId))) return { state, turns: saved.turns }
  const at = new Date(now()).toISOString()
  purchase.status = 'captured'
  purchase.capture_id = captureId
  purchase.at = at
  const paid: ScoutEvent = { t: 'paid', card: purchase.card, gift: purchase.gift, order_id: orderId, capture_id: captureId, amount, at, ...(purchase.product_title ? { product_title: purchase.product_title } : {}), ...(purchase.product_url ? { product_url: purchase.product_url } : {}) }
  const turns = saved.turns.map((events) => (events.some((e) => e.t === 'order' && e.order_id === orderId) ? [...events, paid] : events))
  return { state, turns }
}

/** One log line per delivery (its answer and event type, nothing secret), then the answer. */
export async function handleWebhook(request: Request, deps: { conversations: Conversations; paypal: PayPal | null; webhookId: string; now?: () => number }): Promise<Response> {
  const res = await answerWebhook(request, deps)
  console.log(`paypal webhook ${res.status} ${res.headers.get('X-Event-Type') ?? 'unverified'}`)
  return res
}

async function answerWebhook(request: Request, deps: { conversations: Conversations; paypal: PayPal | null; webhookId: string; now?: () => number }): Promise<Response> {
  const contentLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) return new Response('payload too large', { status: 413 })
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_WEBHOOK_BYTES) return new Response('payload too large', { status: 413 })
  try { JSON.parse(raw) } catch { return new Response('invalid JSON', { status: 400 }) }
  if (!deps.paypal) return new Response('unauthorized', { status: 401 })
  let verified: boolean
  try { verified = await deps.paypal.verifyWebhook(request.headers, raw, deps.webhookId) } catch { return new Response('verification unavailable', { status: 503 }) }
  if (!verified) return new Response('unauthorized', { status: 401 })
  const event = parseEvent(raw)
  if (!event) return Response.json({ status: 'ignored' }, { headers: { 'X-Event-Type': 'other' } })
  const customId = event.customId
  if (!customId?.startsWith('gs-')) return Response.json({ status: 'ignored' }, { headers: { 'X-Event-Type': event.type } })
  const match = customId.match(/^gs-([A-Za-z0-9_-]{6,48})-(t\d{1,2}c\d{1,2})$/)
  if (!match || !event.orderId) return Response.json({ status: 'ignored' }, { headers: { 'X-Event-Type': event.type } })
  const conversationId = match[1]
  const cardId = match[2]
  return withOrderLock(conversationId + ':' + event.orderId, async () => {
    const saved = await deps.conversations.get(conversationId)
    const state = saved?.state as State | undefined
    const purchase = state?.purchases?.find((p) => p.order_id === event.orderId)
    if (!saved || !state || !purchase || purchase.status === 'captured') return Response.json({ status: purchase?.status === 'captured' ? 'ok' : 'ignored' }, { headers: { 'X-Event-Type': event.type } })
    // A genuine PayPal event for a different card is not ours to act on.
    if (cardId !== purchase.card) return Response.json({ status: 'ignored' }, { headers: { 'X-Event-Type': event.type } })
    let captureId: string, amount: string
    if (event.type === 'CHECKOUT.ORDER.APPROVED') {
      try {
        const cap = await deps.paypal!.capture(event.orderId!)
        if (cap.status !== 'COMPLETED' || cap.customId !== customId) return Response.json({ status: 'ignored' }, { headers: { 'X-Event-Type': event.type } })
        captureId = cap.captureId; amount = cap.amount
      } catch { return new Response('capture failed', { status: 502 }) }
    } else if (event.type === 'PAYMENT.CAPTURE.COMPLETED') {
      captureId = event.captureId!; amount = event.amount!
    } else return Response.json({ status: 'ignored' }, { headers: { 'X-Event-Type': event.type } })
    if (!sameAmount(amount, purchase.amount)) {
      console.log(`paypal webhook amount mismatch ${event.orderId}`)
      return Response.json({ status: 'ignored' }, { headers: { 'X-Event-Type': event.type } })
    }
    const fresh = await deps.conversations.get(conversationId)
    const freshState = fresh?.state as State | undefined
    const freshPurchase = freshState?.purchases?.find((p) => p.order_id === event.orderId)
    if (!fresh || !freshState || !freshPurchase || freshPurchase.status === 'captured' || fresh.turns.flat().some((e) => e.t === 'paid' && (e.order_id === event.orderId || e.capture_id === captureId))) return Response.json({ status: 'ok' }, { headers: { 'X-Event-Type': event.type } })
    const updated = markPaid(fresh, freshPurchase, event.orderId!, captureId, amount, deps.now ?? Date.now)
    await deps.conversations.put(conversationId, updated.state, updated.turns)
    return Response.json({ status: 'ok' }, { headers: { 'X-Event-Type': event.type } })
  })
}

export interface BuyDeps {
  conversations: Conversations
  paypal: PayPal | null
  live: null | { model: Model; budget: Budget; takeVisitorBuy(): Promise<boolean> }
  origin: string
  ownerSecret: string
  now?: () => number
}

export async function ownerToken(conversationId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(conversationId))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function tokenMatchesOwner(conversationId: string, token: unknown, secret: string): Promise<boolean> {
  const expected = await ownerToken(conversationId, secret)
  const valid = typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)
  const candidate = valid ? token as string : '0'.repeat(64)
  let difference = valid ? 0 : 1
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ candidate.charCodeAt(i)
  return difference === 0
}

export async function parseBuy(request: Request): Promise<{ conversation: string; card: string; method: PayMethod; owner?: string } | null> {
  const body = (await request.json().catch(() => null)) as { conversation?: unknown; card?: unknown; method?: unknown; owner?: unknown } | null
  const ok = (v: unknown, re: RegExp) => typeof v === 'string' && re.test(v)
  if (!body || !ok(body.conversation, /^[A-Za-z0-9_-]{6,48}$/) || !ok(body.card, /^t\d{1,2}c\d{1,2}$/)) return null
  return { conversation: body.conversation as string, card: body.card as string, method: body.method === 'card' ? 'card' : 'paypal', owner: typeof body.owner === 'string' ? body.owner : undefined }
}

export async function buyTurn(conversationId: string, cardId: string, deps: BuyDeps, send: (e: ScoutEvent) => Promise<void>, method: PayMethod = 'paypal', owner?: string): Promise<void> {
  if (!(await tokenMatchesOwner(conversationId, owner, deps.ownerSecret))) return
  const saved = await deps.conversations.get(conversationId)
  if (!saved) { await send({ t: 'error', text: 'That conversation has gone. Start a new one.' }); return }
  const state = saved.state as State
  const card = state.cards.find((c) => c.id === cardId)
  if (!card) { await send({ t: 'error', text: 'That card is not in this conversation any more.' }); return }
  const run: ScoutEvent = { t: 'run', conversation: conversationId, turn: state.turn, mode: 'live', said: 'Buy this one: ' + card.gift, purpose: 'buy' }
  if (!deps.paypal || !deps.live) {
    await send({ ...run, mode: 'off' })
    await send({ t: 'error', text: 'Buying is off right now. Nothing was charged.' })
    return
  }
  if (!(await deps.live.takeVisitorBuy())) {
    await send({ ...run, mode: 'off' })
    await send({ t: 'error', text: 'You have bought a lot today. Nothing was charged.' })
    return
  }
  const events: ScoutEvent[] = [run]
  await send(run)
  const next = await runBuyTurn({
    cardId, method, state, model: deps.live.model, budget: deps.live.budget, paypal: deps.paypal, origin: deps.origin, now: deps.now,
    emit: async (e) => {
      events.push(e); await send(e)
    },
  })
  await deps.conversations.put(conversationId, next, [...saved.turns, events])
  await send({ t: 'done', share: '/s/' + conversationId })
}

const page = (status: number, text: string) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gift Scout</title>` +
  `<body style="font: 16px Inter, sans-serif; padding: 32px; background: #f7f5f0; color: #292a25"><p>${text}</p><p><a href="/">Back to Gift Scout</a></p></body>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
)

/** PayPal's return link: `/paid?c=<conversation>&token=<order id>&PayerID=...`. Captures once, then shows the conversation. */
export async function paidReturn(url: URL, deps: { conversations: Conversations; paypal: PayPal | null; now?: () => number; retryMs?: number }): Promise<Response> {
  const c = url.searchParams.get('c') ?? ''
  const orderId = url.searchParams.get('token') ?? ''
  if (!/^[A-Za-z0-9_-]{6,48}$/.test(c) || !/^[A-Z0-9]{8,32}$/.test(orderId) || !deps.paypal) return page(400, 'That link is not one Gift Scout made.')
  return withOrderLock(c + ':' + orderId, async () => {
    const saved = await deps.conversations.get(c)
    const state = saved?.state as State | undefined
    const purchase = state?.purchases?.find((p) => p.order_id === orderId)
    // Only an order this conversation made is captured.
    if (!saved || !state || !purchase) return page(404, 'Gift Scout made no such order.')
    const back = Response.redirect(`${url.origin}/s/${encodeURIComponent(c)}`, 303)
    if (purchase.status === 'captured' || saved.turns.flat().some((e) => e.t === 'paid' && (e.order_id === orderId || e.capture_id === purchase.capture_id))) return back
    let cap
    try { cap = await deps.paypal!.capture(orderId) } catch (e) {
      // The webhook may have captured it a moment before the buyer came back: then PayPal refuses a second capture (422),
      // and the conversation already shows it paid.
      if (e instanceof PayPalError && e.status === 422) {
        await new Promise((resolve) => setTimeout(resolve, deps.retryMs ?? 1500))
        const again = (await deps.conversations.get(c))?.state as State | undefined
        if (again?.purchases?.find((p) => p.order_id === orderId)?.status === 'captured') return back
      }
      const why = e instanceof PayPalError && e.status === 422 ? 'PayPal has not had this payment approved yet.' : 'PayPal did not take the payment. Nothing was charged.'
      return page(e instanceof PayPalError && e.status === 422 ? 409 : 502, why)
    }
    if (cap.status !== 'COMPLETED') return page(502, 'PayPal could not confirm the payment. Check PayPal before trying again.')
    if (cap.customId !== `gs-${c}-${purchase.card}`) return page(400, 'That payment is not one Gift Scout made.')
    if (!sameAmount(cap.amount, purchase.amount)) {
      console.log(`paypal webhook amount mismatch ${orderId}`)
      return page(200, 'We could not confirm the payment amount.')
    }
    const fresh = await deps.conversations.get(c)
    const freshState = fresh?.state as State | undefined
    const freshPurchase = freshState?.purchases?.find((p) => p.order_id === orderId)
    if (!fresh || !freshState || !freshPurchase || freshPurchase.status === 'captured' || fresh.turns.flat().some((e) => e.t === 'paid' && (e.order_id === orderId || e.capture_id === cap.captureId))) return back
    const updated = markPaid(fresh, freshPurchase, orderId, cap.captureId, cap.amount, deps.now ?? Date.now)
    await deps.conversations.put(c, updated.state, updated.turns)
    return back
  })
}
