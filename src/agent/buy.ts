// The purchase: the last tool call of the agent, after one human tap. The person taps "Buy this one" on a card; only then
// is the agent offered buy_gift, and code lets it buy only that card, for the exact amount shown before the tap. The
// tool makes a PayPal sandbox order and hands back the approval link; the buyer approves at PayPal, and the return page
// captures. No money moves without the tap and the buyer's own approval at PayPal.
import { validate, type JsonSchema } from '../mcp/schema'
import { PayPalError, SANDBOX_TEST_CARD, type Order, type PayPal, type Shipping } from '../paypal/client'
import { MIN_GIFT_PRICE, type Budget, type ConversationState } from './agent'
import type { Card, ScoutEvent } from './events'
import { callReserve, neuronsFor, type ChatMessage, type Model } from './model'

/** The whole dollar quote shown before a payment for an idea. */
export function quoteFor(card: Pick<Card, 'price_low' | 'price_high'>): number {
  return Math.min(Math.floor(card.price_high), Math.max(MIN_GIFT_PRICE, Math.ceil(card.price_low), Math.round((card.price_low + card.price_high) / 2)))
}

export const BUY_GIFT: { name: string; description: string; inputSchema: JsonSchema } = {
  name: 'buy_gift',
  description: 'Buy the gift card the person tapped, in the PayPal sandbox. Gives back the link where they approve the payment.',
  inputSchema: {
    type: 'object',
    properties: {
      card_id: { type: 'string', minLength: 2, maxLength: 12, description: 'The id of the card they tapped.' },
      amount_usd: { type: 'number', minimum: 1, maximum: 500, description: 'The exact amount given in the request, in US dollars.' },
    },
    required: ['card_id', 'amount_usd'],
    additionalProperties: false,
  },
}

export const BUY_PROMPT = 'You are Gift Scout. The person tapped "Buy this one" on a gift card. Call buy_gift once with that card id ' +
  'and the exact amount in US dollars given in the request. Nothing else.'

export interface Purchase {
  card: string
  gift: string
  order_id: string
  amount: string
  status: 'created' | 'captured' | 'refund_pending' | 'refunded'
  capture_id?: string
  /** City and state only. The street goes to PayPal and is never saved here. */
  ship_to?: string
  tracker_id?: string
  refund_id?: string
  at?: string
  product_title?: string
  product_url?: string
  approve_url?: string
}

/** How the buyer pays: approve at PayPal (a sandbox login), or PayPal's published test card, paid at once. */
export type PayMethod = 'paypal' | 'card'

export interface Attempt {
  card: string
  request_id: string
  amount: string
  method: PayMethod
  status: 'sent' | 'unknown' | 'failed' | 'done'
  order_id?: string
  at: string
  /** SHA256 of the original request, salted with its request ID. No street address is saved. */
  request_fingerprint?: string
  ship_to?: string
  creation_claim?: { id: string; until: number }
}

export interface BuyOptions {
  takeVisitorBuy?: () => Promise<boolean>
  /** The route persists each transition before continuing the payment. */
  saveAttempt?: (attempt: Attempt) => Promise<Attempt | void>
  claimCreation?: (attempt: Attempt) => Promise<boolean>
  releaseCreation?: (attempt: Attempt) => Promise<void>
  cardId: string
  method?: PayMethod
  /** Where the gift goes. It rides on the PayPal order; only its city and state are kept. */
  shipping?: Shipping
  state: ConversationState & { purchases?: Purchase[] }
  model: Model
  budget: Budget
  paypal: PayPal
  /** The Worker's own origin, for PayPal's return and cancel links. */
  origin: string
  emit(e: ScoutEvent): void | Promise<void>
  now?: () => number
}

const MAX_BUY_MODEL_CALLS = 2

export const shipTo = (shipping: Shipping) => `${shipping.city}, ${shipping.state}`

/** After a capture, a tracker on an order that has an address. A failed tracker leaves the payment as it is: the card
 *  simply shows no tracker. The tracking number is made from the capture, so a repeat asks PayPal for the same one. */
export async function trackShipment(paypal: PayPal, purchase: Purchase, now: () => number): Promise<ScoutEvent | null> {
  if (!purchase.ship_to || !purchase.capture_id || purchase.tracker_id) return null
  const trackingNumber = 'GS' + purchase.capture_id
  try {
    const tracker = await paypal.addTracker(purchase.order_id, purchase.capture_id, trackingNumber)
    purchase.tracker_id = tracker.id
    return { t: 'shipped', card: purchase.card, order_id: purchase.order_id, capture_id: purchase.capture_id, tracker_id: tracker.id, tracking_number: trackingNumber, ship_to: purchase.ship_to, at: new Date(now()).toISOString() }
  } catch {
    console.log(`paypal tracker failed ${purchase.order_id}`)
    return null
  }
}

type BuyState = BuyOptions['state']
const buyLocks = new Map<string, { tail: Promise<void>; participants: number; state?: BuyState }>()

/** The lock covers overlapping requests in one isolate; requests in other isolates rely on the saved conversation. */
async function withBuyLock(key: string, action: (pending?: BuyState) => Promise<BuyState>): Promise<BuyState> {
  const entry = buyLocks.get(key)
  const currentEntry = entry ?? { tail: Promise.resolve(), participants: 0 }
  currentEntry.participants++
  const previous = currentEntry.tail
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  currentEntry.tail = current
  if (!entry) buyLocks.set(key, currentEntry)
  await previous
  try {
    const result = await action(currentEntry.state)
    currentEntry.state = result
    return result
  } finally {
    release()
    currentEntry.participants--
    if (currentEntry.participants === 0 && buyLocks.get(key) === currentEntry) buyLocks.delete(key)
  }
}

/** Runs a buy turn. Emits call, result and order (or an error) and usage; returns the new state. */
export async function runBuyTurn(o: BuyOptions): Promise<ConversationState & { purchases?: Purchase[] }> {
  return withBuyLock(`${o.state.id}:${o.cardId}`, (pending) => runBuyTurnLocked(o, pending))
}

const UNKNOWN_PAYMENT = 'We did not hear back from PayPal. Tap Pay again to check, or check PayPal.'
const UNRESOLVED_PAYMENT = 'This payment is unresolved. Check PayPal before starting another payment. We cannot safely send this request again.'
// Orders v2 retains PayPal-Request-Id for six hours. Leave a minute for network transit.
const CREATE_RETRY_MS = 6 * 60 * 60 * 1000 - 60 * 1000
const FAILED_PAYMENT = 'PayPal did not make the order. Nothing was charged.'
const WAITING_PAYMENT = 'PayPal made the order but has not confirmed the payment yet. Tap Pay again to check.'
const refused = (status?: string) => ['VOIDED', 'DECLINED', 'DENIED', 'FAILED'].includes(status ?? '')

async function runBuyTurnLocked(o: BuyOptions, pending?: BuyState): Promise<BuyState> {
  const now = o.now ?? Date.now
  const method: PayMethod = o.method ?? 'paypal'
  const state = structuredClone(o.state)
  if (pending) {
    const attempts = new Map((state.attempts ?? []).map(a => [a.request_id, a]))
    for (const attempt of pending.attempts ?? []) if (attempt.card === o.cardId) attempts.set(attempt.request_id, attempt)
    if (attempts.size) state.attempts = [...attempts.values()]
    for (const purchase of pending.purchases ?? []) if (purchase.card === o.cardId) {
      state.purchases = [...(state.purchases ?? []).filter(p => p.order_id !== purchase.order_id), purchase]
    }
    state.calls = Math.max(state.calls, pending.calls)
  }
  const card = state.cards.find((c) => c.id === o.cardId)
  if (!card) {
    await o.emit({ t: 'error', text: 'That card is not in this conversation any more.' })
    return state
  }
  if (state.purchases?.some((purchase) => purchase.card === card.id && purchase.status === 'refunded')) {
    await o.emit({ t: 'error', text: 'That gift was refunded.' })
    return state
  }
  if (state.purchases?.some((purchase) => purchase.card === card.id && (purchase.status === 'captured' || purchase.status === 'refund_pending'))) {
    await o.emit({ t: 'error', text: 'That gift has already been paid for.' })
    return state
  }
  const existing = state.purchases?.find(p => p.card === card.id && p.status === 'created' && !state.attempts?.some(a => a.order_id === p.order_id && a.status === 'failed'))
  const active = state.attempts?.find(a => a.card === card.id && (a.status === 'sent' || a.status === 'unknown'))
    ?? state.attempts?.find(a => a.card === card.id && a.order_id && a.status === 'done' && (!existing || (a.order_id === existing.order_id && (a.method === 'card' || !existing.approve_url))))
  if (existing && !active) {
    state.purchases = [...(state.purchases ?? []).filter((purchase) => purchase.order_id !== existing.order_id), existing]
    if (method === 'paypal' && existing.approve_url) {
      await o.emit({ t: 'order', card: existing.card, gift: existing.gift, order_id: existing.order_id, amount: existing.amount, method: 'paypal', ...(existing.product_title ? { product_title: existing.product_title } : {}), ...(existing.product_url ? { product_url: existing.product_url } : {}), approve_url: existing.approve_url })
    } else {
      await o.emit({ t: 'error', text: 'This gift already has a PayPal order waiting. Approve it at PayPal first.' })
    }
    return state
  }
  const saveAttempt = async (attempt: Attempt) => {
    const saved = await o.saveAttempt?.(structuredClone(attempt)) ?? attempt
    state.attempts = [...(state.attempts ?? []).filter(a => a.request_id !== saved.request_id), saved]
    return saved
  }
  const productFields = card.product ? { product_title: card.product.title, product_url: card.product.url } : {}
  const requestFor = (attempt: Attempt) => ({
    amount: attempt.amount, customId: `gs-${state.id}-${card.id}`, description: card.product?.title ?? card.gift,
    returnUrl: `${o.origin}/paid?c=${encodeURIComponent(state.id)}`, cancelUrl: `${o.origin}/s/${encodeURIComponent(state.id)}`,
    requestId: attempt.request_id, ...(attempt.method === 'card' ? { card: { ...SANDBOX_TEST_CARD } } : {}),
    ...(o.shipping ? { shipping: { name: o.shipping.name, line1: o.shipping.line1, city: o.shipping.city, state: o.shipping.state, postal: o.shipping.postal } } : {}),
  })
  const fingerprint = async (attempt: Attempt) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(requestFor(attempt))))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }
  const performClaimedAttempt = async (attempt: Attempt, n: number) => {
    if (!attempt.order_id) {
      const age = now() - Date.parse(attempt.at)
      if (!Number.isFinite(age) || age < 0 || age >= CREATE_RETRY_MS || !attempt.request_fingerprint || attempt.request_fingerprint !== await fingerprint(attempt)) {
        await saveAttempt({ ...attempt, status: 'unknown' })
        await o.emit({ t: 'error', text: UNRESOLVED_PAYMENT })
        return
      }
    }
    const started = now()
    let order: Order | undefined
    let failed = false
    let creating = false
    try {
      if (attempt.order_id) {
        order = await o.paypal.getOrder(attempt.order_id)
        if (order.id !== attempt.order_id || order.customId !== `gs-${state.id}-${card.id}` || (order.amount !== undefined && Number(order.amount) !== Number(attempt.amount))) throw new Error('order does not match')
        if (order.status === 'APPROVED' && !order.captureId) {
          const cap = await o.paypal.capture(order.id)
          if (cap.status !== 'COMPLETED' || !cap.captureId || cap.customId !== `gs-${state.id}-${card.id}` || Number(cap.amount) !== Number(attempt.amount)) throw new Error('capture not confirmed')
          order = { ...order, status: 'COMPLETED', captureId: cap.captureId, captureStatus: cap.status, amount: cap.amount }
        }
        if (order.captureId && (order.status !== 'COMPLETED' || order.captureStatus !== 'COMPLETED' || !order.amount)) throw new Error('capture not confirmed')
      } else {
        creating = true
        order = await o.paypal.createOrder(requestFor(attempt))
      }
      failed = refused(order.status) || refused(order.captureStatus)
      if (!order.id || !order.status || failed) throw new Error('order not confirmed')
    } catch (error) {
      failed ||= creating && error instanceof PayPalError && [400, 401, 403, 404, 405, 406, 415, 422].includes(error.status)
      const orderId = attempt.order_id || order?.id || (error instanceof PayPalError ? error.orderId : undefined)
      await saveAttempt({ ...attempt, status: failed ? 'failed' : 'unknown', ...(orderId ? { order_id: orderId } : {}) })
      if (orderId && !failed) state.purchases = [...(state.purchases ?? []).filter(p => p.order_id !== orderId), existing ?? {
        card: card.id, gift: card.gift, order_id: orderId, amount: attempt.amount, status: 'created', ...productFields,
        ...(attempt.ship_to ? { ship_to: attempt.ship_to } : {}),
      }]
      const text = failed ? FAILED_PAYMENT : UNKNOWN_PAYMENT
      await o.emit({ t: 'result', n, tool: BUY_GIFT.name, ok: false, ms: Math.round(now() - started), cached: false, text, top: [] })
      await o.emit({ t: 'error', text })
      return
    }
    const incomplete = !order.captureId && attempt.method === 'paypal' && !order.approveUrl
    await saveAttempt({ ...attempt, status: incomplete ? 'unknown' : 'done', order_id: order.id })
    const purchase: Purchase = { ...existing, card: card.id, gift: card.gift, order_id: order.id, amount: attempt.amount, status: 'created', ...productFields,
      ...(order.approveUrl ? { approve_url: order.approveUrl } : {}), ...(attempt.ship_to ? { ship_to: attempt.ship_to } : {}) }
    if (order.captureId) Object.assign(purchase, { status: 'captured', capture_id: order.captureId, at: new Date(now()).toISOString() })
    state.purchases = [...(state.purchases ?? []).filter(p => p.order_id !== order.id), purchase]
    const text = incomplete ? UNKNOWN_PAYMENT : order.captureId
      ? `PayPal sandbox order ${order.id} for $${attempt.amount}, payment confirmed.`
      : attempt.method === 'card' ? WAITING_PAYMENT : `PayPal sandbox order ${order.id} for $${attempt.amount}, waiting for the buyer to approve.`
    await o.emit({ t: 'result', n, tool: BUY_GIFT.name, ok: !incomplete, ms: Math.round(now() - started), cached: false, text, top: [] })
    await o.emit({ t: 'order', card: card.id, gift: card.gift, order_id: order.id, amount: attempt.amount, method: attempt.method, ...productFields, ...(order.approveUrl ? { approve_url: order.approveUrl } : {}) })
    if (order.captureId) {
      await o.emit({ t: 'paid', card: card.id, gift: card.gift, order_id: order.id, capture_id: order.captureId, amount: attempt.amount, at: purchase.at!, ...productFields })
      const shipped = await trackShipment(o.paypal, purchase, now)
      if (shipped) await o.emit(shipped)
    } else if (incomplete || attempt.method === 'card') await o.emit({ t: 'error', text })
  }
  const performAttempt = async (attempt: Attempt, n: number) => {
    if (attempt.status === 'failed') {
      await o.emit({ t: 'error', text: FAILED_PAYMENT })
      return
    }
    if (!attempt.order_id && o.claimCreation) {
      if (!(await o.claimCreation(attempt))) {
        await o.emit({ t: 'error', text: 'This payment is still being checked. Tap Pay again in a minute.' })
        return
      }
      try { await performClaimedAttempt(attempt, n) }
      finally { await o.releaseCreation?.(attempt) }
    } else await performClaimedAttempt(attempt, n)
  }
  if (active) {
    if (method !== active.method) await o.emit({ t: 'error', text: 'A payment for this gift is still being checked with PayPal.' })
    const n = ++state.calls
    await o.emit({ t: 'call', n, tool: BUY_GIFT.name, args: { card_id: card.id, amount_usd: Number(active.amount) } })
    if (!active.order_id) await saveAttempt({ ...active, status: 'sent' })
    await performAttempt(active, n)
    await o.emit({ t: 'usage', model_calls: 0, neurons: 0 })
    return state
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: BUY_PROMPT },
    { role: 'user', content: card.product
      ? `They tapped card ${card.id}: ${card.gift}. Product: ${card.product.title}, $${card.product.price}. The amount must be exactly ${card.product.price}.`
      : `They tapped card ${card.id}: ${card.gift}. The amount must be exactly ${quoteFor(card)}.` },
  ]
  const spec = { type: 'function' as const, function: { name: BUY_GIFT.name, description: BUY_GIFT.description, parameters: BUY_GIFT.inputSchema } }
  let modelCalls = 0
  let neurons = 0
  let bought = false
  let paypalCalled = false
  while (modelCalls < MAX_BUY_MODEL_CALLS && !bought) {
    const held = await o.budget.reserve(callReserve(messages, [spec], 200))
    if (!held) {
      await o.emit({ t: 'error', text: 'Live scouting has used its budget for today, so buying waits until tomorrow.' })
      break
    }
    let reply
    try { reply = await o.model.chat(messages, [spec], 200) } catch (error) {
      console.error('model call failed', error instanceof Error ? error.message : String(error))
      await o.emit({ t: 'error', text: 'The model did not answer. Try again in a minute.' })
      break
    }
    modelCalls++
    const spent = reply.neurons ?? neuronsFor(reply.prompt_tokens, reply.completion_tokens)
    neurons += spent
    await held.settle(spent)
    const call = reply.tool_calls.find((c) => c.function.name === BUY_GIFT.name)
    if (!call) {
      messages.push({ role: 'assistant', content: reply.content })
      messages.push({ role: 'user', content: `Call buy_gift with card_id ${card.id}.` })
      continue
    }
    let args: Record<string, unknown>
    try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown> } catch { args = {} }
    messages.push({ role: 'assistant', content: reply.content, tool_calls: [call] })
    // The gate, in code: only the tapped card, only its exact amount.
    const problems = validate(BUY_GIFT.inputSchema, args)
    const amount = Number(args.amount_usd)
    const refusal = problems.length ? problems[0]
      : args.card_id !== card.id ? `Only card ${card.id} was tapped.`
      : card.product && amount !== card.product.price ? `The amount must be exactly ${card.product.price} for ${card.product.title}.`
      // With a product the exact price is the rule: it may sit below the band's low end (any price from MIN_GIFT_PRICE).
      : !card.product && amount !== quoteFor(card) ? `The amount must be exactly ${quoteFor(card)}.`
      : ''
    const n = ++state.calls
    await o.emit({ t: 'call', n, tool: BUY_GIFT.name, args })
    if (refusal) {
      await o.emit({ t: 'result', n, tool: BUY_GIFT.name, ok: false, ms: 0, cached: false, text: refusal, top: [] })
      messages.push({ role: 'tool', tool_call_id: call.id, name: BUY_GIFT.name, content: 'Not bought: ' + refusal })
      continue
    }
    if (o.takeVisitorBuy && !(await o.takeVisitorBuy())) {
      await o.emit({ t: 'error', text: 'You have bought a lot today. Nothing was charged.' })
      return state
    }
    const proposed: Attempt = { card: card.id, request_id: `gs-${state.id}-${card.id}-a${1 + (state.attempts ?? []).filter(a => a.card === card.id && a.status === 'failed').length}`,
      amount: (card.product?.price ?? quoteFor(card)).toFixed(2), method, status: 'sent', at: new Date(now()).toISOString(),
      ...(o.shipping ? { ship_to: shipTo(o.shipping) } : {}) }
    proposed.request_fingerprint = await fingerprint(proposed)
    const attempt = await saveAttempt(proposed)
    if (method !== attempt.method) await o.emit({ t: 'error', text: 'A payment for this gift is still being checked with PayPal.' })
    paypalCalled = true
    await performAttempt(attempt, n)
    bought = !!state.purchases?.some(p => p.card === card.id)
    break
  }
  if (!bought && !paypalCalled && modelCalls >= MAX_BUY_MODEL_CALLS) await o.emit({ t: 'error', text: 'The purchase did not go through. Nothing was charged.' })
  await o.emit({ t: 'usage', model_calls: modelCalls, neurons: Math.round(neurons * 10) / 10 })
  return state
}
