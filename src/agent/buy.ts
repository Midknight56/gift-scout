// The purchase: the last tool call of the agent, after one human tap. The person taps "Buy this one" on a card; only then
// is the agent offered buy_gift, and code lets it buy only that card, for an amount inside the card's price band. The
// tool makes a PayPal sandbox order and hands back the approval link; the buyer approves at PayPal, and the return page
// captures. No money moves without the tap and the buyer's own approval at PayPal.
import { validate, type JsonSchema } from '../mcp/schema'
import { SANDBOX_TEST_CARD, type PayPal, type Shipping } from '../paypal/client'
import type { Budget, ConversationState } from './agent'
import type { ScoutEvent } from './events'
import { neuronsFor, type ChatMessage, type Model } from './model'

export const BUY_GIFT: { name: string; description: string; inputSchema: JsonSchema } = {
  name: 'buy_gift',
  description: 'Buy the gift card the person tapped, in the PayPal sandbox. Gives back the link where they approve the payment.',
  inputSchema: {
    type: 'object',
    properties: {
      card_id: { type: 'string', minLength: 2, maxLength: 12, description: 'The id of the card they tapped.' },
      amount_usd: { type: 'number', minimum: 1, maximum: 500, description: 'What to pay, in US dollars, inside the card price band.' },
    },
    required: ['card_id', 'amount_usd'],
    additionalProperties: false,
  },
}

export const BUY_PROMPT = 'You are Gift Scout. The person tapped "Buy this one" on a gift card. Call buy_gift once with that card id ' +
  'and a fair amount in US dollars inside its price band. Nothing else.'

export interface Purchase {
  card: string
  gift: string
  order_id: string
  amount: string
  status: 'created' | 'captured' | 'refunded'
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

export interface BuyOptions {
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

const buyLocks = new Map<string, { tail: Promise<void>; participants: number; purchase?: Purchase }>()

/** The lock covers overlapping requests in one isolate; requests in other isolates rely on the saved conversation. */
async function withBuyLock<T>(key: string, action: (waiting: boolean, pending?: Purchase) => Promise<T>, remember: (value: T) => Purchase | undefined): Promise<T> {
  const entry = buyLocks.get(key)
  const waiting = !!entry
  const currentEntry = entry ?? { tail: Promise.resolve(), participants: 0 }
  currentEntry.participants++
  const previous = currentEntry.tail
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  currentEntry.tail = current
  if (!entry) buyLocks.set(key, currentEntry)
  await previous
  try {
    const result = await action(waiting, waiting ? currentEntry.purchase : undefined)
    currentEntry.purchase = remember(result) ?? currentEntry.purchase
    return result
  } finally {
    release()
    currentEntry.participants--
    if (currentEntry.participants === 0 && buyLocks.get(key) === currentEntry) buyLocks.delete(key)
  }
}

/** Runs a buy turn. Emits call, result and order (or an error) and usage; returns the new state. */
export async function runBuyTurn(o: BuyOptions): Promise<ConversationState & { purchases?: Purchase[] }> {
  return withBuyLock(`${o.state.id}:${o.cardId}`, (waiting, pending) => runBuyTurnLocked(o, waiting ? pending : undefined), (value) => value.purchases?.find((purchase) => purchase.card === o.cardId))
}

async function runBuyTurnLocked(o: BuyOptions, pending?: Purchase): Promise<ConversationState & { purchases?: Purchase[] }> {
  const now = o.now ?? Date.now
  const method: PayMethod = o.method ?? 'paypal'
  const state = structuredClone(o.state)
  const card = state.cards.find((c) => c.id === o.cardId)
  if (!card) {
    await o.emit({ t: 'error', text: 'That card is not in this conversation any more.' })
    return state
  }
  if (state.purchases?.some((purchase) => purchase.card === card.id && purchase.status === 'refunded')) {
    await o.emit({ t: 'error', text: 'That gift was refunded.' })
    return state
  }
  const savedOpen = state.purchases?.find((purchase) => purchase.card === card.id && purchase.status === 'created')
  if (pending && !state.purchases?.some((purchase) => purchase.card === card.id && purchase.status === 'captured')) {
    state.purchases = [...(state.purchases ?? []).filter((purchase) => purchase.order_id !== pending.order_id), pending]
  }
  const existing = state.purchases?.some((purchase) => purchase.card === card.id && purchase.status === 'captured') ? undefined : savedOpen ?? pending
  if (existing) {
    state.purchases = [...(state.purchases ?? []).filter((purchase) => purchase.order_id !== existing.order_id), existing]
    if (method === 'paypal' && existing.approve_url) {
      await o.emit({ t: 'order', card: existing.card, gift: existing.gift, order_id: existing.order_id, amount: existing.amount, method: 'paypal', ...(existing.product_title ? { product_title: existing.product_title } : {}), ...(existing.product_url ? { product_url: existing.product_url } : {}), approve_url: existing.approve_url })
    } else {
      await o.emit({ t: 'error', text: 'This gift already has a PayPal order waiting. Approve it at PayPal first.' })
    }
    return state
  }
  if (state.purchases?.some((purchase) => purchase.card === card.id && purchase.status === 'captured')) {
    await o.emit({ t: 'error', text: 'That gift has already been paid for.' })
    return state
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: BUY_PROMPT },
    { role: 'user', content: card.product
      ? `They tapped card ${card.id}: ${card.gift}. Product: ${card.product.title}, $${card.product.price}. The amount must be exactly ${card.product.price}.`
      : `They tapped card ${card.id}: ${card.gift}, $${card.price_low} to $${card.price_high}.` },
  ]
  const spec = { type: 'function' as const, function: { name: BUY_GIFT.name, description: BUY_GIFT.description, parameters: BUY_GIFT.inputSchema } }
  let modelCalls = 0
  let neurons = 0
  let bought = false
  while (modelCalls < MAX_BUY_MODEL_CALLS && !bought) {
    const held = await o.budget.reserve()
    if (!held) {
      await o.emit({ t: 'error', text: 'Live scouting has used its budget for today, so buying waits until tomorrow.' })
      break
    }
    let reply
    try { reply = await o.model.chat(messages, [spec], 200) } catch {
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
    // The gate, in code: only the tapped card, only inside its price band.
    const problems = validate(BUY_GIFT.inputSchema, args)
    const amount = Number(args.amount_usd)
    const refusal = problems.length ? problems[0]
      : args.card_id !== card.id ? `Only card ${card.id} was tapped.`
      : card.product && amount !== card.product.price ? `The amount must be exactly ${card.product.price} for ${card.product.title}.`
      // With a product the exact price is the rule: it may sit below the band's low end (any price from MIN_GIFT_PRICE).
      : !card.product && (amount < card.price_low || amount > card.price_high) ? `The amount must be from ${card.price_low} to ${card.price_high}.`
      : ''
    const n = ++state.calls
    await o.emit({ t: 'call', n, tool: BUY_GIFT.name, args })
    const started = now()
    if (refusal) {
      await o.emit({ t: 'result', n, tool: BUY_GIFT.name, ok: false, ms: 0, cached: false, text: refusal, top: [] })
      messages.push({ role: 'tool', tool_call_id: call.id, name: BUY_GIFT.name, content: 'Not bought: ' + refusal })
      continue
    }
    const value = amount.toFixed(2)
    try {
      const order = await o.paypal.createOrder({
        amount: value,
        customId: `gs-${state.id}-${card.id}`,
        description: card.product?.title ?? card.gift,
        returnUrl: `${o.origin}/paid?c=${encodeURIComponent(state.id)}`,
        cancelUrl: `${o.origin}/s/${encodeURIComponent(state.id)}`,
        requestId: `gs-${state.id}-${card.id}-${value}-${method}`,
        ...(method === 'card' ? { card: SANDBOX_TEST_CARD } : {}),
        ...(o.shipping ? { shipping: o.shipping } : {}),
      })
      if (method === 'card' ? !order.captureId : !order.approveUrl) throw new Error('order not usable')
      const text = method === 'card'
        ? `PayPal sandbox order ${order.id} for $${value}, paid with PayPal's test card.`
        : `PayPal sandbox order ${order.id} for $${value}, waiting for the buyer to approve.`
      await o.emit({ t: 'result', n, tool: BUY_GIFT.name, ok: true, ms: Math.round(now() - started), cached: false, text, top: [] })
      const productFields = card.product ? { product_title: card.product.title, product_url: card.product.url } : {}
      await o.emit({ t: 'order', card: card.id, gift: card.gift, order_id: order.id, amount: value, method, ...productFields, ...(order.approveUrl ? { approve_url: order.approveUrl } : {}) })
      const purchase: Purchase = { card: card.id, gift: card.gift, order_id: order.id, amount: value, status: 'created', ...(order.approveUrl ? { approve_url: order.approveUrl } : {}), ...(o.shipping ? { ship_to: shipTo(o.shipping) } : {}) }
      if (card.product) Object.assign(purchase, productFields)
      if (order.captureId) {
        const at = new Date(now()).toISOString()
        Object.assign(purchase, { status: 'captured', capture_id: order.captureId, at })
        await o.emit({ t: 'paid', card: card.id, gift: card.gift, order_id: order.id, capture_id: order.captureId, amount: value, at, ...productFields })
        const shipped = await trackShipment(o.paypal, purchase, now)
        if (shipped) await o.emit(shipped)
      }
      state.purchases = [...(state.purchases ?? []).filter((p) => p.order_id !== order.id), purchase]
      bought = true
    } catch {
      const text = method === 'card'
        ? 'PayPal could not confirm the payment. Check PayPal before trying again.'
        : 'PayPal did not make the order.'
      await o.emit({ t: 'result', n, tool: BUY_GIFT.name, ok: false, ms: Math.round(now() - started), cached: false, text, top: [] })
      await o.emit({ t: 'error', text: method === 'card' ? text : 'PayPal did not make the order. Try again in a minute.' })
      break
    }
  }
  if (!bought && modelCalls >= MAX_BUY_MODEL_CALLS) await o.emit({ t: 'error', text: 'The purchase did not go through. Nothing was charged.' })
  await o.emit({ t: 'usage', model_calls: modelCalls, neurons: Math.round(neurons * 10) / 10 })
  return state
}
