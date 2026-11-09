// POST /api/buy   the "Buy this one" tap: one buy turn of the agent, streamed like a scout turn, ending in an order.
// GET  /paid      PayPal sends the buyer back here after approval: the order is captured and the conversation shows it.
// POST /api/refund "Changed my mind": the capture is refunded in full and the conversation shows it.
import type { Channel3Client, ProductResult } from '../channel3/client'
import { pickProduct, plain, type Budget, type ConversationState } from '../agent/agent'
import { quoteFor, runBuyTurn, trackShipment, type PayMethod, type Purchase } from '../agent/buy'
import type { CardProduct, ScoutEvent } from '../agent/events'
import type { Model } from '../agent/model'
import { matchesGiftVariants } from '../agent/product-type'
import { PayPalError, type PayPal, type Shipping } from '../paypal/client'
import { parseEvent } from '../paypal/webhook'
import type { Conversations, SavedConversation } from '../store/d1'

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
    return value.trim() && Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null
  }
  return cents(left) !== null && cents(left) === cents(right)
}

/** Adds an event to the turn that holds this order's order or paid event. */
function appendToOrderTurn(turns: ScoutEvent[][], orderId: string, event: ScoutEvent): ScoutEvent[][] {
  const index = turns.findIndex((events) => events.some((e) => (e.t === 'order' || e.t === 'paid') && e.order_id === orderId))
  return index < 0 ? turns : turns.map((events, i) => (i === index ? [...events, event] : events))
}

function markPaid(saved: SavedConversation, orderId: string, captureId: string, amount: string, at: string): SavedConversation | null {
  const state = saved.state as State
  const purchase = state.purchases?.find((p) => p.order_id === orderId)
  if (!purchase || purchase.status !== 'created' || saved.turns.flat().some((event) => event.t === 'paid' && (event.order_id === orderId || event.capture_id === captureId))) return null
  const paid: ScoutEvent = { t: 'paid', card: purchase.card, gift: purchase.gift, order_id: orderId, capture_id: captureId, amount, at, ...(purchase.product_title ? { product_title: purchase.product_title } : {}), ...(purchase.product_url ? { product_url: purchase.product_url } : {}) }
  const appended = appendToOrderTurn(saved.turns, orderId, paid)
  const turns = appended === saved.turns ? [...saved.turns, [{ t: 'order' as const, card: purchase.card, gift: purchase.gift, order_id: orderId, amount, ...(purchase.product_title ? { product_title: purchase.product_title } : {}), ...(purchase.product_url ? { product_url: purchase.product_url } : {}) }, paid]] : appended
  return { state: { ...state,
    ...(state.attempts ? { attempts: state.attempts.map(a => a.order_id === orderId ? { ...a, status: 'done' as const } : a) } : {}),
    purchases: state.purchases?.map((p) => p.order_id === orderId ? { ...p, status: 'captured' as const, capture_id: captureId, at } : p) } as State, turns }
}

/** Persist the capture before asking for a tracker; neither external call runs in a retry. */
async function savePaid(conversations: Conversations, id: string, orderId: string, captureId: string, amount: string, paypal: PayPal, now: () => number, recoverCard?: string): Promise<void> {
  const at = new Date(now()).toISOString()
  const paid = await conversations.update(id, (fresh) => {
    const state = fresh.state as State
    if (recoverCard && !state.purchases?.some(p => p.order_id === orderId)) {
      const attempt = state.attempts?.find(a => a.card === recoverCard && (a.status === 'sent' || a.status === 'unknown') && (!a.order_id || a.order_id === orderId) && sameAmount(a.amount, amount))
      const card = state.cards.find(c => c.id === recoverCard)
      if (!attempt || !card || state.purchases?.some(p => p.card === recoverCard && p.status !== 'created')) return null
      const purchase: Purchase = { card: card.id, gift: card.gift, order_id: orderId, amount, status: 'created',
        ...(card.product ? { product_title: card.product.title, product_url: card.product.url } : {}),
        ...(attempt.ship_to ? { ship_to: attempt.ship_to } : {}) }
      fresh = {
        state: { ...state, purchases: [...(state.purchases ?? []), purchase], attempts: state.attempts?.map(a => a.request_id === attempt.request_id ? { ...a, status: 'done', order_id: orderId } : a) } as State,
        turns: [...fresh.turns, [{ t: 'order', card: card.id, gift: card.gift, order_id: orderId, amount, method: attempt.method, ...(card.product ? { product_title: card.product.title, product_url: card.product.url } : {}) }]],
      }
    }
    return markPaid(fresh, orderId, captureId, amount, at)
  })
  const purchase = (paid?.state as State | undefined)?.purchases?.find((p) => p.order_id === orderId)
  if (!purchase) return
  const shipped = await trackShipment(paypal, structuredClone(purchase), now)
  if (!shipped || shipped.t !== 'shipped') return
  await conversations.update(id, (fresh) => {
    const state = fresh.state as State
    const current = state.purchases?.find((p) => p.order_id === orderId)
    if (!current || current.tracker_id) return null
    return {
      state: { ...state, purchases: state.purchases?.map((p) => p.order_id === orderId ? { ...p, tracker_id: shipped.tracker_id } : p) } as State,
      turns: appendToOrderTurn(fresh.turns, orderId, shipped),
    }
  })
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
    const attempt = state?.attempts?.find(a => a.card === cardId && (a.status === 'sent' || a.status === 'unknown') && (!a.order_id || a.order_id === event.orderId) && !!event.amount && sameAmount(a.amount, event.amount))
    if (!saved || !state || (!purchase && !attempt) || purchase?.status === 'captured') return Response.json({ status: purchase?.status === 'captured' ? 'ok' : 'ignored' }, { headers: { 'X-Event-Type': event.type } })
    // A genuine PayPal event for a different card is not ours to act on.
    if (purchase && cardId !== purchase.card) return Response.json({ status: 'ignored' }, { headers: { 'X-Event-Type': event.type } })
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
    if (!sameAmount(amount, purchase?.amount ?? attempt!.amount)) {
      console.log(`paypal webhook amount mismatch ${event.orderId}`)
      return Response.json({ status: 'ignored' }, { headers: { 'X-Event-Type': event.type } })
    }
    await savePaid(deps.conversations, conversationId, event.orderId!, captureId, amount, deps.paypal!, deps.now ?? Date.now, purchase ? undefined : cardId)
    return Response.json({ status: 'ok' }, { headers: { 'X-Event-Type': event.type } })
  })
}

export interface BuyDeps {
  products?: Pick<Channel3Client, 'product'> | null
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

/** A US address, or null when any field is missing or malformed. */
export function parseShipping(value: unknown): Shipping | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const text = (x: unknown, max: number) => (typeof x === 'string' && x.trim().length >= 1 && x.trim().length <= max && !/[\u0000-\u001f<>]/.test(x) ? x.trim() : null)
  const name = text(v.name, 60), line1 = text(v.line1, 100), city = text(v.city, 60)
  const state = typeof v.state === 'string' && /^[A-Za-z]{2}$/.test(v.state.trim()) ? v.state.trim().toUpperCase() : null
  const postal = typeof v.postal === 'string' && /^\d{5}$/.test(v.postal.trim()) ? v.postal.trim() : null
  return name && line1 && city && state && postal ? { name, line1, city, state, postal } : null
}

export interface OfferSnapshot { id: string; price: number; title: string; url: string }

function shopHost(url: string): string {
  try { return new URL(url).host.toLowerCase() } catch { return '' }
}

/** Only these tracking parameters are known to leave the purchased offer unchanged. Channel3's `aid` is new on every
 * product read (the same `o` offer came back with a new aid each time, 6 Nov 2026), so keeping it stopped every order. */
function offerIdentity(value: string): string {
  try {
    const url = new URL(value)
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']) url.searchParams.delete(key)
    if (url.host.toLowerCase() === 'buy.trychannel3.com') url.searchParams.delete('aid')
    url.searchParams.sort()
    return url.href
  } catch { return '' }
}

function offerChanged(card: string, product: CardProduct, old?: OfferSnapshot): ScoutEvent {
  const changes: ('price' | 'title' | 'shop' | 'offer')[] = []
  if (!old || old.price !== product.price) changes.push('price')
  if (!old || plain(old.title).toLowerCase() !== plain(product.title).toLowerCase()) changes.push('title')
  if (!old || shopHost(old.url) !== shopHost(product.url)) changes.push('shop')
  else if (old.id !== product.id || !offerIdentity(old.url) || offerIdentity(old.url) !== offerIdentity(product.url)) changes.push('offer')
  return { t: 'offer_changed', card, title: product.title, old_price: old?.price ?? 0, new_price: product.price,
    changes, old_title: old?.title, new_title: product.title, shop: product.merchant ?? shopHost(product.url), product }
}

export async function parseBuy(request: Request): Promise<{ conversation: string; card: string; method: PayMethod; owner?: string; ship?: Shipping; offer?: OfferSnapshot; quote?: number } | null> {
  const body = (await request.json().catch(() => null)) as { conversation?: unknown; card?: unknown; method?: unknown; owner?: unknown; ship?: unknown; offer?: unknown; quote?: unknown } | null
  const ok = (v: unknown, re: RegExp) => typeof v === 'string' && re.test(v)
  if (!body || !ok(body.conversation, /^[A-Za-z0-9_-]{6,48}$/) || !ok(body.card, /^t\d{1,2}c\d{1,2}$/)) return null
  const ship = body.ship === undefined ? undefined : parseShipping(body.ship)
  if (ship === null) return null
  let offer: OfferSnapshot | undefined
  if (body.offer !== undefined) {
    if (!body.offer || typeof body.offer !== 'object' || Array.isArray(body.offer)) return null
    const v = body.offer as Record<string, unknown>
    if (![v.id, v.title, v.url].every(x => typeof x === 'string' && x.length > 0 && x.length < 400) || typeof v.price !== 'number' || !Number.isFinite(v.price)) return null
    offer = { id: v.id as string, title: v.title as string, url: v.url as string, price: v.price }
  }
  if (body.quote !== undefined && (typeof body.quote !== 'number' || !Number.isFinite(body.quote))) return null
  return { ...(offer ? { offer } : {}), ...(body.quote !== undefined ? { quote: body.quote as number } : {}), conversation: body.conversation as string, card: body.card as string, method: body.method === 'card' ? 'card' : 'paypal', owner: typeof body.owner === 'string' ? body.owner : undefined, ...(ship ? { ship } : {}) }
}

/** "Changed my mind": a full refund of a paid gift, for the tab that started the conversation only. No model call. */
export async function refundPurchase(
  req: { conversation: string; card: string; owner?: string },
  deps: { conversations: Conversations; paypal: PayPal | null; ownerSecret: string; now?: () => number },
): Promise<{ status: number; event?: ScoutEvent; error?: string }> {
  if (!(await tokenMatchesOwner(req.conversation, req.owner, deps.ownerSecret))) return { status: 403, error: 'Only the person who bought it can refund it.' }
  if (!deps.paypal) return { status: 503, error: 'Refunds are off right now.' }
  const paypal = deps.paypal
  const saved = await deps.conversations.get(req.conversation)
  const purchase = (saved?.state as State | undefined)?.purchases?.find((p) => p.card === req.card && p.status !== 'created')
  if (!saved || !purchase?.capture_id) return { status: 409, error: 'That gift has not been paid for.' }
  return withOrderLock(req.conversation + ':' + purchase.order_id, async () => {
    const fresh = await deps.conversations.get(req.conversation)
    const state = fresh?.state as State | undefined
    const current = state?.purchases?.find((p) => p.order_id === purchase.order_id)
    if (!fresh || !state || !current?.capture_id) return { status: 409, error: 'That gift has not been paid for.' }
    if (current.status === 'refunded') return { status: 409, error: 'That gift was already refunded.' }
    let refund
    try { refund = current.status === 'refund_pending' && current.refund_id
      ? await paypal.getRefund(current.refund_id)
      : await paypal.refund(current.capture_id) } catch (e) {
      console.log(`paypal refund failed ${current.order_id} ${e instanceof PayPalError ? e.status : ''}`)
      return { status: 502, error: 'PayPal did not answer. Tap again to check; it will not refund twice.' }
    }
    const failed = refund.status === 'FAILED' || refund.status === 'CANCELLED'
    if (refund.status !== 'COMPLETED' && refund.status !== 'PENDING' && !failed) return { status: 502, error: 'PayPal did not confirm the refund. Check PayPal.' }
    if (refund.status === 'PENDING' && current.status === 'refund_pending') {
      return { status: 202, error: 'PayPal is still working on the refund.' }
    }
    const status = failed ? 'captured' : refund.status === 'PENDING' ? 'refund_pending' : 'refunded'
    const type = failed ? 'refund_failed' : refund.status === 'PENDING' ? 'refund_pending' : 'refunded'
    const at = new Date((deps.now ?? Date.now)()).toISOString()
    const event: ScoutEvent = { t: type, card: current.card, gift: current.gift, order_id: current.order_id, capture_id: current.capture_id, refund_id: refund.id, amount: current.amount, at }
    await deps.conversations.update(req.conversation, (latest) => {
      const state = latest.state as State
      const purchase = state.purchases?.find((p) => p.order_id === current.order_id)
      if (!purchase || purchase.status === 'refunded') return null
      return {
        state: { ...state, purchases: state.purchases?.map((p) => p.order_id === current.order_id ? { ...p, status, refund_id: refund.id } : p) } as State,
        turns: appendToOrderTurn(latest.turns, current.order_id, event),
      }
    })
    return { status: status === 'refund_pending' ? 202 : 200, event, ...(failed ? { error: 'PayPal did not complete the refund. The payment stands.' } : {}) }
  })
}

export async function parseRefund(request: Request): Promise<{ conversation: string; card: string; owner?: string } | null> {
  const body = (await request.json().catch(() => null)) as { conversation?: unknown; card?: unknown; owner?: unknown } | null
  const ok = (v: unknown, re: RegExp) => typeof v === 'string' && re.test(v)
  if (!body || !ok(body.conversation, /^[A-Za-z0-9_-]{6,48}$/) || !ok(body.card, /^t\d{1,2}c\d{1,2}$/)) return null
  return { conversation: body.conversation as string, card: body.card as string, owner: typeof body.owner === 'string' ? body.owner : undefined }
}

export async function buyTurn(conversationId: string, cardId: string, deps: BuyDeps, send: (e: ScoutEvent) => Promise<void>, method: PayMethod = 'paypal', owner?: string, shipping?: Shipping, offer?: OfferSnapshot, quote?: number): Promise<void> {
  if (!(await tokenMatchesOwner(conversationId, owner, deps.ownerSecret))) return
  return withOrderLock(`${conversationId}:buy:${cardId}`, () => buyTurnLocked(conversationId, cardId, deps, send, method, shipping, offer, quote))
}

async function buyTurnLocked(conversationId: string, cardId: string, deps: BuyDeps, send: (e: ScoutEvent) => Promise<void>, method: PayMethod, shipping?: Shipping, offer?: OfferSnapshot, quote?: number): Promise<void> {
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
  const events: ScoutEvent[] = [run]
  await send(run)
  const hasPurchase = state.purchases?.some(p => p.card === cardId && !state.attempts?.some(a => a.order_id === p.order_id && a.status === 'failed'))
  const hasAttempt = state.attempts?.some(a => a.card === cardId && (a.status === 'sent' || a.status === 'unknown' || (a.status === 'done' && !!a.order_id)))
  const mismatch = card.product
    ? !offer || offer.id !== card.product.id || offer.price !== card.product.price || offer.title !== card.product.title || !offerIdentity(offer.url) || offerIdentity(offer.url) !== offerIdentity(card.product.url)
    : quote !== quoteFor(card)
  if (mismatch && !hasAttempt) {
    const event: ScoutEvent = card.product ? offerChanged(cardId, card.product, offer)
      : { t: 'offer_changed', card: cardId, title: card.gift, old_price: quote ?? 0, new_price: quoteFor(card) }
    events.push(event)
    await deps.conversations.update(conversationId, fresh => ({ ...fresh, turns: [...fresh.turns, events] }))
    await send(event)
    await send({ t: 'done', share: '/s/' + conversationId })
    return
  }
  if (card.product && !hasPurchase && !hasAttempt) {
    const n = ++state.calls
    const started = (deps.now ?? Date.now)()
    const emit = async (event: ScoutEvent) => { events.push(event); await send(event) }
    await emit({ t: 'call', n, tool: 'check_offer', args: { id: card.product.id, title: card.product.title } })
    let result: ProductResult
    try { result = card.product.id && deps.products ? await deps.products.product(card.product.id) : { ok: false, reason: 'off' } }
    catch { result = { ok: false, reason: 'error' } }
    if (result.ok && (result.product.id !== card.product.id || result.product.currency.toUpperCase() !== 'USD' || !Number.isFinite(result.product.price) || result.product.price < 5 || result.product.price > 500)) result = { ok: false, reason: 'gone' }
    const overBudget = result.ok && result.product.price > card.price_high
    if (result.ok && !overBudget && (!pickProduct({ ok: true, cached: false, products: [result.product] }, card.entity.name, card.entity.type, card.price_high, card.gift) ||
      !matchesGiftVariants(result.product, card.product.title))) result = { ok: false, reason: 'gone' }
    const text = result.ok ? 'Offer checked.' : result.reason === 'gone' ? 'That item is not on offer any more. The idea stays.' : 'We could not check the price just now. Nothing was charged.'
    await emit({ t: 'result', n, tool: 'check_offer', ok: result.ok, ms: Math.round((deps.now ?? Date.now)() - started), cached: false, text, top: [] })
    const old = card.product
    const freshProduct = result.ok ? { ...old, ...result.product, title: plain(result.product.title), ...(result.product.brand ? { brand: plain(result.product.brand) } : {}), source: 'channel3' as const } : undefined
    const change = freshProduct ? offerChanged(cardId, freshProduct, { ...old, id: old.id ?? '' }) : undefined
    const changed = change?.t === 'offer_changed' && !!change.changes?.length
    const gone = (!result.ok && result.reason === 'gone') || overBudget
    if (changed || gone || !result.ok) {
      const event: ScoutEvent = result.ok && overBudget
        ? { t: 'offer_gone', card: cardId, title: old.title, reason: 'over_budget', new_price: result.product.price }
        : result.ok
          ? change!
          : gone ? { t: 'offer_gone', card: cardId, title: old.title } : { t: 'error', text }
      events.push(event)
      await deps.conversations.update(conversationId, fresh => ({
        state: { ...fresh.state, calls: Math.max(fresh.state.calls, state.calls), cards: fresh.state.cards.map(c => {
          if (c.id !== cardId || c.product?.id !== old.id) return c
          const { product: _product, ...idea } = c
          return freshProduct && !overBudget ? { ...idea, product: freshProduct } : gone ? idea : c
        }) },
        turns: [...fresh.turns, events],
      }))
      await send(event)
      await send({ t: 'done', share: '/s/' + conversationId })
      return
    }
    if (freshProduct) card.product = freshProduct
  }
  const claimId = crypto.randomUUID()
  const next = await runBuyTurn({
    cardId, method, shipping, state, takeVisitorBuy: deps.live.takeVisitorBuy, model: deps.live.model, budget: deps.live.budget, paypal: deps.paypal, origin: deps.origin, now: deps.now,
    saveAttempt: async attempt => {
      let savedId = attempt.request_id
      const saved = await deps.conversations.update(conversationId, fresh => {
        savedId = attempt.request_id
        const attempts = new Map((fresh.state.attempts ?? []).map(a => [a.request_id, a]))
        const active = [...attempts.values()].find(a => a.card === attempt.card && a.status !== 'failed')
        if (!attempts.has(attempt.request_id) && active) {
          savedId = active.request_id
          return fresh
        }
        const current = attempts.get(attempt.request_id)
        const settled = current?.order_id && (fresh.state as State).purchases?.some(p => p.order_id === current.order_id && p.status !== 'created')
        if (!current) attempts.set(attempt.request_id, attempt)
        else if (!settled && !current.order_id && attempt.status === 'sent' && (current.status === 'sent' || current.status === 'unknown')) {
          attempts.set(attempt.request_id, { ...current, status: 'sent' })
        }
        else if (!settled && attempt.status !== 'sent' && (!current.order_id || current.order_id === attempt.order_id)) {
          attempts.set(attempt.request_id, { ...current, status: attempt.status, ...(attempt.order_id ? { order_id: attempt.order_id } : {}) })
        }
        return { ...fresh, state: { ...fresh.state, attempts: [...attempts.values()] } }
      })
      return saved?.state.attempts?.find(a => a.request_id === savedId)
    },
    claimCreation: async attempt => {
      // The shared CAS claim outlives the client's bounded request timeout. A lost Worker can
      // be retried after expiry, using the same request ID and fingerprint within six hours.
      const now = (deps.now ?? Date.now)()
      const claimed = await deps.conversations.update(conversationId, fresh => {
        const current = fresh.state.attempts?.find(a => a.request_id === attempt.request_id)
        if (!current || current.order_id || current.status === 'failed' || current.status === 'done' ||
          (current.creation_claim && current.creation_claim.until > now) ||
          (fresh.state as State).purchases?.some(p => p.card === attempt.card &&
            !fresh.state.attempts?.some(a => a.order_id === p.order_id && a.status === 'failed'))) return null
        return { ...fresh, state: { ...fresh.state, attempts: fresh.state.attempts?.map(a => a === current
          ? { ...a, creation_claim: { id: claimId, until: now + 60_000 } } : a) } }
      })
      return !!claimed
    },
    releaseCreation: async attempt => {
      await deps.conversations.update(conversationId, fresh => ({ ...fresh, state: { ...fresh.state,
        attempts: fresh.state.attempts?.map(a => {
          if (a.request_id !== attempt.request_id || a.creation_claim?.id !== claimId) return a
          const { creation_claim: _claim, ...released } = a
          return released
        }),
      } }))
    },
    emit: async (e) => {
      events.push(e); await send(e)
    },
  })
  const changed = (next.purchases ?? []).filter((purchase) =>
    JSON.stringify(purchase) !== JSON.stringify(state.purchases?.find((p) => p.order_id === purchase.order_id)))
  await deps.conversations.update(conversationId, (fresh) => {
    const state = fresh.state as State
    const purchases = new Map((state.purchases ?? []).map((p) => [p.order_id, p]))
    for (const purchase of changed) {
      const current = purchases.get(purchase.order_id)
      if (!current || current.status === 'created') purchases.set(purchase.order_id, purchase)
    }
    const prior = fresh.turns.flat()
    const uniqueEvents = events.filter(e => e.t !== 'paid' || !prior.some(p => p.t === 'paid' && (p.order_id === e.order_id || p.capture_id === e.capture_id)))
    return {
      state: { ...state, ...(changed.length ? { purchases: [...purchases.values()] } : {}), calls: Math.max(state.calls, next.calls) } as State,
      turns: [...fresh.turns, uniqueEvents],
    }
  })
  await send({ t: 'done', share: '/s/' + conversationId })
}

export const page = (status: number, text: string) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gift Scout</title>` +
  `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
  `<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css"></head>` +
  `<body class="message-page"><main class="message-box"><p class="wordmark">GS<span>·</span></p><h1>${text}</h1><a class="buy-button message-back" href="/">Back to Gift Scout</a></main></body></html>`,
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
      if (e instanceof PayPalError && e.status === 422) return page(409, 'PayPal has not had this payment approved yet.')
      const uncertain = 'PayPal did not confirm the payment yet. Open this link again in a minute, or check PayPal.'
      try {
        const order = await deps.paypal!.getOrder(orderId)
        if (!order.captureId) return page(502, 'PayPal did not take the payment. Nothing was charged.')
        if (order.status !== 'COMPLETED' || order.captureStatus !== 'COMPLETED' || !order.amount) return page(502, uncertain)
        cap = { orderId, status: order.captureStatus, captureId: order.captureId, amount: order.amount, customId: order.customId }
      } catch { return page(502, uncertain) }
    }
    if (cap.status !== 'COMPLETED') return page(502, 'PayPal could not confirm the payment. Check PayPal before trying again.')
    if (cap.customId !== `gs-${c}-${purchase.card}`) return page(400, 'That payment is not one Gift Scout made.')
    if (!sameAmount(cap.amount, purchase.amount)) {
      console.log(`paypal webhook amount mismatch ${orderId}`)
      return page(200, 'We could not confirm the payment amount.')
    }
    await savePaid(deps.conversations, c, orderId, cap.captureId, cap.amount, deps.paypal!, deps.now ?? Date.now)
    return back
  })
}
