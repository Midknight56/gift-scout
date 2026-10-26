// The Gift Scout agent: a tool loop on Workers AI over Qloo's taste graph. The model decides which Qloo questions to
// ask; code runs them, keeps every result, and checks the gift ideas at the end. A card is kept only when its entity
// came back from a taste_insights call in this conversation, so the model cannot invent an affinity: the affinity, the
// entity's name and the seeds on a card are copied from the tool result by code, never from the model's words.
import { validate, type JsonSchema } from '../mcp/schema'
import type { Tool } from '../mcp/server'
import type { Entity, Tag } from '../qloo/client'
import type { SearchResult } from '../channel3/client'
import type { QlooContext } from '../qloo/tools'
import type { Card, Dropped, Found, ScoutEvent } from './events'
import { neuronsFor, type ChatMessage, type Model, type ToolSpec } from './model'
import { carryOut, PLAN_SCOUT, type Plan, type Ran } from './plan'
import { SYSTEM_PROMPT } from './prompt'
import { fixWhyPronouns, pronounsFromMessage } from './pronouns'
import { budgetIn, plain, saidIn } from './text'

export { budgetIn, plain, saidIn }

export const MAX_CARDS = 6
/** Cards of one kind (book, place, ...): six ideas should not be three podcasts. */
export const MAX_PER_KIND = 2
/** A card under this many dollars at its top price is not a gift: the model offered "a podcast episode" at $1. */
export const MIN_GIFT_PRICE = 5
/** The most buy_gift may order (its amount_usd maximum), so no card shows a price it could not buy. */
export const MAX_GIFT_PRICE = 500
/** Model calls in one turn. A full first turn measured 3 to 4; the rest is room for one retry. */
export const MAX_MODEL_CALLS = 6
/** Qloo tool calls in one turn. A first turn needs about 8 (three searches, five insights). */
export const MAX_TOOL_CALLS = 14
// Measured 26 Oct 2026: a full present_gifts answer for "Frida Kahlo and Mexican food" was cut at 900 tokens, 2,359
// characters, about 2.6 a token (the ids are long), and the turn ended with no cards. 1,400 gives that answer about
// half again as much room. A call at the cap: the largest present step input in the ledger that day was about 5,300
// tokens (a 52 neuron call), 5,300 x 4,625 / 1e6 = 24.5, plus 1,400 x 30,475 / 1e6 = 42.7, is 67.2, under the 73
// neuron reserve (MAX_CALL_NEURONS). 1,600 would be 73.3, over it. The daily caps still stop all spending, so $0.
export const MAX_OUTPUT_TOKENS = 1400

export interface ConversationState {
  id: string
  /** Turns done so far. */
  turn: number
  /** Tool calls so far, across turns: the `n` of the next call is calls + 1. */
  calls: number
  /** What the person said, turn by turn. */
  said: string[]
  /** Names of every entity and tag a tool returned, by id. */
  names: Record<string, string>
  /** Every entity a taste_insights call returned: the only ground a card may stand on. */
  found: Record<string, { entity: Found; seeds: string[]; tag_seeds?: string[]; from_call: number }>
  cards: Card[]
  /** The most they want to spend, once they have said. */
  budget_max?: number
}

export function newState(id: string): ConversationState {
  return { id, turn: 0, calls: 0, said: [], names: {}, found: {}, cards: [] }
}

/** Room held for one model call; settle writes what the call really cost. */
export interface Reservation {
  settle(neurons: number): Promise<void>
}

/** Checks the model can spend, and holds room for a call before it runs. */
export interface Budget {
  allow(): Promise<boolean>
  reserve(): Promise<Reservation | null>
}

export const PRESENT_GIFTS: { name: string; description: string; inputSchema: JsonSchema } = {
  name: 'present_gifts',
  description:
    'Your ideas, grouped by the kind of Qloo result they rest on. Fill every kind that has results with one or two ideas.',
  inputSchema: {
    type: 'object',
    properties: {
      ideas: {
        type: 'object',
        properties: Object.fromEntries(['brand', 'book', 'podcast', 'destination', 'place', 'artist'].map((kind) => [kind, {
          type: 'array', maxItems: 2, items: {
            type: 'object', properties: {
              entity_id: { type: 'string', minLength: 1, maxLength: 64, description: 'The id of the entity from taste_insights.' },
              gift: { type: 'string', minLength: 3, maxLength: 80, description: 'What to give, in a few words.' },
              why: { type: 'string', minLength: 5, maxLength: 220, description: 'One plain sentence on why fans of what they love would like it. Never say who wrote, made, sang or directed it, or call it a seed name followed by novel, book, album, film or similar.' },
              price_low: { type: 'integer', minimum: 1, maximum: 5000, description: 'US dollars.' },
              price_high: { type: 'integer', minimum: 1, maximum: 5000, description: 'US dollars.' },
            }, required: ['entity_id', 'gift', 'why', 'price_low', 'price_high'], additionalProperties: false,
          },
        }])), additionalProperties: false,
      },
      // Keep accepting recorded runs and later turns made with the original shape.
      cards: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            entity_id: { type: 'string', minLength: 1, maxLength: 64, description: 'The id of the entity from taste_insights.' },
            gift: { type: 'string', minLength: 3, maxLength: 80, description: 'What to give, in a few words.' },
            why: { type: 'string', minLength: 5, maxLength: 220, description: 'One plain sentence on why fans of what they love would like it. Never say who wrote, made, sang or directed it, or call it a seed name followed by novel, book, album, film or similar.' },
            price_low: { type: 'integer', minimum: 1, maximum: 5000, description: 'US dollars.' },
            price_high: { type: 'integer', minimum: 1, maximum: 5000, description: 'US dollars.' },
          },
          required: ['entity_id', 'gift', 'why', 'price_low', 'price_high'],
          additionalProperties: false,
        },
      },
      budget_max: { type: 'integer', minimum: 1, maximum: 5000, description: 'The most the person wants to spend, if they said.' },
    },
    required: [],
    additionalProperties: false,
  },
}

export function toolSpecs(tools: Tool<QlooContext>[]): ToolSpec[] {
  return [...tools, PLAN_SCOUT, PRESENT_GIFTS].map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
}

/** The tools offered at each step. A small model given every tool at once skipped Qloo and wrote cards on made up ids
 *  (measured 23 Oct 2026: six of six dropped). A first turn is plan then present; a later turn starts with every tool
 *  and soon must present. A step moves on once the model has made a call in it. */
export const FIRST_TURN_STEPS = [['plan_scout'], ['present_gifts']]
export const LATER_TURN_STEPS = [['search_entities', 'search_tags', 'taste_insights', 'present_gifts'], ['taste_insights', 'present_gifts'], ['present_gifts']]

const STEP_HINTS: Record<string, string> = {
  plan_scout: 'First call plan_scout with what they love.',
  taste_insights: 'Now call taste_insights with those ids, once for each kind of gift.',
  present_gifts: 'Now call present_gifts with your ideas, each on an entity_id from taste_insights.',
  search_entities: 'First find what they love with search_entities or search_tags.',
}

interface ProposedCard { entity_id: string; gift: string; why: string; price_low: number; price_high: number; kind?: string }

const IDEA_ORDER = ['book', 'brand', 'place', 'destination', 'podcast', 'artist'] as const
const CHEAPER_GIFT: Record<(typeof IDEA_ORDER)[number], (name: string) => string> = {
  book: (name) => `a copy of ${name}`,
  brand: (name) => `a small item from ${name}`,
  place: (name) => `a small treat at ${name}`,
  destination: (name) => `a lower-cost visit to ${name}`,
  podcast: (name) => `merch from ${name}`,
  artist: (name) => `a print or merch from ${name}`,
}

function availableKinds(state: ConversationState): typeof IDEA_ORDER[number][] {
  return IDEA_ORDER.filter((kind) => Object.values(state.found).some((f) => f.entity.type === kind))
}

function unusedKinds(state: ConversationState, cards: Card[]): string {
  const missing = availableKinds(state).filter((kind) => !cards.some((c) => c.entity.type === kind))
  if (!missing.length) return ''
  const names = missing.map((kind) => Object.values(state.found).find((f) => f.entity.type === kind)!.entity.name)
  const kinds = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`
  return ` Qloo also gave ${kinds} results (${names.join(', ')}): add one idea for each.`
}

function refusedGiftFeedback(dropped: Dropped[], state: ConversationState, budgetMax?: number): string {
  const groups = new Map<string, string[]>()
  for (const { gift, reason } of dropped) groups.set(reason, [...(groups.get(reason) ?? []), gift])
  const parts: string[] = []
  for (const [reason, gifts] of groups) {
    if (reason === 'no Qloo result behind it') {
      parts.push('None of those rest on a taste_insights result. Use the ids it returned.')
    } else if (reason === 'over the budget') {
      parts.push(`${reason}: ${gifts.join(', ')}. Each idea must start at or under $${budgetMax}. Choose cheaper gifts: ${availableKinds(state).map((kind) => CHEAPER_GIFT[kind](Object.values(state.found).find((f) => f.entity.type === kind)!.entity.name)).join('; ')}.`)
    } else {
      parts.push(`${reason}: ${gifts.join(', ')}.`)
    }
  }
  return `${parts.join(' ')}${unusedKinds(state, [])}`
}

export function flattenIdeas(ideas: Partial<Record<(typeof IDEA_ORDER)[number], Omit<ProposedCard, 'kind'>[]>>): ProposedCard[] {
  return [0, 1].flatMap((index) => IDEA_ORDER.flatMap((kind) => ideas[kind]?.[index] ? [{ ...ideas[kind]![index], kind }] : []))
}

/** Strong swear words in a title: Qloo returned a real book with one in its name for Phoebe Bridgers fans. */
const ROUGH = /\b(shit|fuck|cunt|bitch)/i

/** The drop rule. Pure, so the tests can hold it to account. */
export function checkCards(proposed: ProposedCard[], state: ConversationState, budgetMax?: number): { cards: Card[]; dropped: Dropped[] } {
  const cards: Card[] = []
  const dropped: Dropped[] = []
  const used = new Set<string>()
  for (const p of proposed) {
    const ground = state.found[p.entity_id]
    const rawLow = Math.min(p.price_low, p.price_high)
    const rawHigh = Math.max(p.price_low, p.price_high)
    // Keep shown prices within what buy_gift can order, and avoid token $1 ideas.
    const low = Math.max(MIN_GIFT_PRICE, rawLow)
    const high = Math.min(MAX_GIFT_PRICE, rawHigh)
    if (!ground) dropped.push({ gift: p.gift, reason: 'no Qloo result behind it' })
    else if (p.kind && ground.entity.type !== p.kind) dropped.push({ gift: p.gift, reason: 'put under the wrong kind' })
    else if (ROUGH.test(ground.entity.name)) dropped.push({ gift: p.gift, reason: 'a title with a swear word, not for a gift card' })
    else if (used.has(p.entity_id)) dropped.push({ gift: p.gift, reason: 'the same Qloo result as another card' })
    else if (rawHigh < MIN_GIFT_PRICE) dropped.push({ gift: p.gift, reason: 'too small to be a gift' })
    else if (low > high) dropped.push({ gift: p.gift, reason: 'no gift price in the supported range' })
    else if (budgetMax !== undefined && low > budgetMax) dropped.push({ gift: p.gift, reason: 'over the budget' })
    else if (cards.filter((c) => c.entity.type === ground.entity.type).length >= MAX_PER_KIND) dropped.push({ gift: p.gift, reason: `a third ${ground.entity.type}` })
    else if (cards.length >= MAX_CARDS) dropped.push({ gift: p.gift, reason: 'more than six ideas' })
    else {
      used.add(p.entity_id)
      const rawWhy = plain(p.why)
      const pronoun = pronounsFromMessage(state.said[0] ?? '')
      const why = pronoun ? fixWhyPronouns(rawWhy, pronoun) : rawWhy
      const maker = seedMaker(why, ground.seeds)
      const seedNames = plain(ground.seeds.join(' and '))
      cards.push({
        id: `t${state.turn}c${cards.length + 1}`,
        gift: plain(p.gift),
        why: maker ? `Loved by fans of ${seedNames}.` : why,
        price_low: low,
        price_high: budgetMax !== undefined ? Math.min(high, budgetMax) : high,
        entity: ground.entity,
        seeds: ground.seeds,
        ...(ground.entity.shares?.length ? { seed_shares: ground.entity.shares.map(({ name, share }) => ({ name, share })) } : {}),
        // Sent even when empty: without it the page lists every unshared seed, so a seed Qloo gave no share looked unscored.
        ...(ground.tag_seeds ? { tag_seeds: ground.tag_seeds } : {}),
        from_call: ground.from_call,
      })
    }
  }
  return { cards, dropped }
}

function seedMaker(why: string, seeds: string[]): boolean {
  // Accents folded on both sides: the seed is "John le Carré", the model writes "Le Carre".
  const fold = (s: string) => plain(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const text = fold(why)
  return seeds.some((seed) => {
    const name = fold(seed)
    const words = name.split(/\s+/)
    const names = [...new Set([name, words.at(-1)!])]
    return names.some((candidate) => {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
      const makerBy = new RegExp(`(?<![\\p{L}\\p{N}])by\\s+${escaped}(?![\\p{L}\\p{N}])`, 'iu')
      const titleAs = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?:['’]s)?\\s+(?:novels?|books?|albums?|records?|songs?|films?|movies?|shows?|series)(?![\\p{L}\\p{N}])`, 'iu')
      return makerBy.test(text) || titleAs.test(text)
    })
  })
}

function toFound(e: Entity): Found {
  const f: Found = { id: e.id, name: e.name, type: e.type }
  if (e.affinity !== undefined) f.affinity = e.affinity
  if (e.detail) f.detail = e.detail
  if (e.address) f.address = e.address
  return f
}

function tagFound(t: Tag): Found { return { id: t.id, name: t.name, type: 'tag' } }

/** What a later turn starts from: the conversation so far, short, instead of every earlier tool answer. */
export function contextFor(state: ConversationState, message: string): string {
  const lines = [`Earlier they said: ${state.said.join(' / ')}`]
  const found = Object.values(state.found)
  if (found.length) {
    lines.push('Results taste_insights already gave (you may use these ids again):')
    for (const f of found) lines.push(`${f.entity.name} (affinity ${(f.entity.affinity ?? 0).toFixed(2)}) [${f.entity.type}] id ${f.entity.id}, from ${f.seeds.join(' and ')}`)
  }
  if (state.cards.length) {
    lines.push('The cards they see now:')
    for (const c of state.cards) lines.push(`${c.gift}, $${c.price_low} to $${c.price_high}, entity ${c.entity.id}`)
  }
  lines.push(`Their new message: ${message}`)
  return lines.join('\n')
}

export interface TurnOptions {
  message: string
  state: ConversationState
  model: Model
  tools: Tool<QlooContext>[]
  ctx: QlooContext
  budget: Budget
  emit(e: ScoutEvent): void | Promise<void>
  products?: { search(query: string, opts?: { limit?: number; maxPrice?: number }): Promise<SearchResult> }
  now?: () => number
}

/** Remove a gift's generic opening words before searching for the named product. */
export function productQuery(gift: string): string {
  return gift.trim().replace(/^(?:(?:a copy of|a bottle of|a subscription to|a gift card for|a set of|a|an|the)\s+)/i, '').trim()
}

function folded(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Keep the first affordable result whose title or brand names the card's Qloo entity. */
export function pickProduct(products: SearchResult, entityName: string, priceHigh: number) {
  if (!products.ok) return undefined
  const entity = folded(entityName)
  const words = entity.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4)
  return products.products.find((product) => {
    if (product.currency.toLowerCase() !== 'usd') return false
    if (product.price < MIN_GIFT_PRICE || product.price > priceHigh) return false
    const text = folded(`${product.title} ${product.brand ?? ''}`)
    return text.includes(entity) || (words.length > 0 && words.every((word) => text.includes(word)))
  })
}

async function attachProducts(cards: Card[], state: ConversationState, products: NonNullable<TurnOptions['products']>, emit: TurnOptions['emit'], now: () => number): Promise<void> {
  const eligible = cards.filter((card) => ['brand', 'book', 'podcast', 'artist'].includes(card.entity.type))
  await Promise.all(eligible.map(async (card) => {
    const gender = pronounsFromMessage(state.said[0] ?? '')
    const prefix = card.entity.type === 'brand' && gender ? (gender === 'he' ? "men's " : "women's ") : ''
    const query = prefix + productQuery(card.gift)
    const n = ++state.calls
    const args = { query, max_price: card.price_high }
    await emit({ t: 'call', n, tool: 'search_products', args })
    const started = now()
    let result: SearchResult
    try { result = await products.search(query, { limit: 10, maxPrice: card.price_high }) }
    catch { result = { ok: false, reason: 'error' } }
    const picked = pickProduct(result, card.entity.name, card.price_high)
    const reason = result.ok ? '' : result.reason === 'capped' ? 'Daily search limit reached.' : result.reason === 'spent' ? 'Product search credits are spent.' : 'Product search failed.'
    if (picked) {
      card.product = { title: picked.title, ...(picked.brand ? { brand: picked.brand } : {}), price: picked.price, url: picked.url, ...(picked.image ? { image: picked.image } : {}), source: 'channel3' }
    }
    const top = picked ? [{ id: picked.id, name: picked.title, type: 'product', price: picked.price } as Found] : []
    await emit({ t: 'result', n, tool: 'search_products', ok: result.ok, ms: Math.round(now() - started), cached: false, text: reason || (picked ? 'Product found.' : 'No matching product in the price range.'), top })
  }))
}

/** Runs one turn. Emits every event except `run` and `done`, which belong to the caller. Returns the new state.
 *  A first turn is plan, then present: the model names what they love, code asks Qloo, the model writes the cards.
 *  A later turn is a free tool loop over the Qloo tools, ending in present_gifts. */
export async function runTurn(o: TurnOptions): Promise<ConversationState> {
  const now = o.now ?? Date.now
  const state: ConversationState = structuredClone(o.state)
  state.turn += 1
  const first = state.said.length === 0
  const pronoun = pronounsFromMessage(state.said[0] ?? o.message)
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + (pronoun === 'he' ? '\nThe person is male: use he, him and his.' : pronoun === 'she' ? '\nThe person is female: use she and her.' : '') },
    { role: 'user', content: first ? o.message : contextFor(state, o.message) },
  ]
  state.said.push(o.message)
  const said = budgetIn(o.message)
  if (said !== undefined) state.budget_max = said
  const allSpecs = toolSpecs(o.tools)
  const steps = first ? FIRST_TURN_STEPS : LATER_TURN_STEPS
  let step = 0
  let modelCalls = 0
  let neurons = 0
  let toolCalls = 0
  let nudged = false
  let retried = false
  let cutRetried = false
  let presented = false
  let modelFailed = false
  /** Entity ids from the last refused present_gifts call, in sorted order. */
  let refusedGiftIds: string[] | undefined
  let refusedGiftFeedbackText = ''
  /** Set when the turn must end with no more model calls (Qloo is down, or it knows none of the loves). */
  let stopped = false
  /** Every tool call made this turn, by name and arguments. */
  const asked = new Set<string>()

  /** Runs one Qloo tool, shows it in the panel, and keeps what it found. */
  const runTool = async (name: string, args: Record<string, unknown>): Promise<Ran> => {
    const tool = o.tools.find((t) => t.name === name)
    if (!tool) return { ok: false, text: 'There is no tool called ' + name, top: [] }
    // A city they never named is taken out before the call: measured 23 Oct 2026, the model sent "New York" for a
    // dad in no city, and Qloo found no place.
    if (typeof args.location === 'string' && !saidIn(args.location, state.said)) delete args.location
    if (name === 'taste_insights') {
      delete args.audience_gender
      const firstPronoun = pronounsFromMessage(state.said[0] ?? o.message)
      if (firstPronoun) args.audience_gender = firstPronoun === 'he' ? 'male' : 'female'
    }
    toolCalls++
    const n = ++state.calls
    await o.emit({ t: 'call', n, tool: name, args })
    const started = now()
    const problems = validate(tool.inputSchema, args)
    const result = problems.length
      ? { content: [{ type: 'text' as const, text: 'Those arguments do not fit: ' + problems.join('; ') }], isError: true }
      : await tool.run(args, o.ctx)
    let text = result.content.map((c) => c.text).join('\n')
    const sc = (result.structuredContent ?? {}) as { cached?: boolean; kind?: string; results?: (Entity | Tag)[]; seed_ids?: string[]; seed_tags?: string[] }
    const raw = sc.results ?? []
    const top: Found[] = name === 'search_tags' || sc.kind === 'tags' ? (raw as Tag[]).map(tagFound) : (raw as Entity[]).map(toFound)
    for (const f of top) state.names[f.id] = f.name
    if (name === 'taste_insights' && !result.isError) {
      const entities = raw as Entity[]
      const named = entities.map((entity) => ({ entity, shares: entity.shares?.flatMap(({ id, share }) => state.names[id] ? [{ name: state.names[id], share }] : []) ?? [] }))
      for (let i = 0; i < top.length; i++) {
        const shares = named[i]?.shares
        if (shares?.length) top[i].shares = shares
      }
      text = named.length ? named.map(({ entity, shares }) => {
        const score = entity.affinity !== undefined ? `, affinity ${entity.affinity.toFixed(2)}` : ''
        const from = shares[0] ? `, mostly from ${shares[0].name} ${Math.round(shares[0].share * 100)}%` : ''
        return `${entity.name} (${entity.type}${score}${from}) id ${entity.id}`
      }).join('\n') : text
    }
    if (name === 'taste_insights' && !result.isError) {
      const seeds = [...new Set([...(sc.seed_ids ?? []), ...(sc.seed_tags ?? [])].map((id) => state.names[id] ?? id))]
      const tagSeeds = (sc.seed_tags ?? []).map((id) => state.names[id] ?? id)
      for (const f of top) {
        const had = state.found[f.id]
        if (!had || (f.affinity ?? 0) > (had.entity.affinity ?? 0)) state.found[f.id] = { entity: f, seeds, tag_seeds: tagSeeds, from_call: n }
      }
    }
    await o.emit({ t: 'result', n, tool: name, ok: !result.isError, ms: Math.round(now() - started), cached: sc.cached === true, text, top: top.slice(0, 8) })
    return { ok: !result.isError, text, top }
  }

  const hint = (offered: string[]) => STEP_HINTS[offered.includes(PRESENT_GIFTS.name) ? PRESENT_GIFTS.name : offered[0]] ?? STEP_HINTS.present_gifts

  while (modelCalls < MAX_MODEL_CALLS && !presented && !stopped) {
    const held = await o.budget.reserve()
    if (!held) {
      await o.emit({ t: 'error', text: 'Live scouting has used its budget for today. The three examples still work.' })
      break
    }
    const offered = steps[Math.min(step, steps.length - 1)]
    let reply
    try {
      reply = await o.model.chat(messages, allSpecs.filter((t) => offered.includes(t.function.name)), MAX_OUTPUT_TOKENS)
    } catch {
      modelFailed = true
      break
    }
    modelCalls++
    const spent = reply.neurons ?? neuronsFor(reply.prompt_tokens, reply.completion_tokens)
    neurons += spent
    await held.settle(spent)

    const usablePresentCall = reply.tool_calls.some((call) => {
      if (call.function.name !== PRESENT_GIFTS.name) return false
      try { return validate(PRESENT_GIFTS.inputSchema, JSON.parse(call.function.arguments || '{}')).length === 0 }
      catch { return false }
    })
    if (reply.cut && offered.includes(PRESENT_GIFTS.name) && !usablePresentCall) {
      if (cutRetried) break
      cutRetried = true
      messages.push({ role: 'assistant', content: '' })
      messages.push({ role: 'user', content: 'Your answer was cut off. Call present_gifts with at most six ideas, one per kind, and why lines of at most ten words.' })
      continue
    }

    if (!reply.tool_calls.length) {
      if (!nudged) {
        // A small model sometimes writes its ideas as prose. One reminder of this step, then it must use the tools.
        nudged = true
        messages.push({ role: 'assistant', content: reply.content })
        messages.push({ role: 'user', content: hint(offered) })
        continue
      }
      if (reply.content && !reply.cut) await o.emit({ t: 'say', text: plain(reply.content) })
      break
    }

    if (reply.content && !reply.cut) await o.emit({ t: 'say', text: plain(reply.content) })
    step++
    messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls })
    let refused = 0
    for (const call of reply.tool_calls) {
      const name = call.function.name
      let args: Record<string, unknown>
      try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown> } catch { args = {} }
      const answer = (content: string) => { messages.push({ role: 'tool', tool_call_id: call.id, name, content }) }

      // Only the step's tools run, and never the same question twice. Measured 23 Oct 2026: offered present_gifts only,
      // the model still asked for destinations four times in a row and the turn ended with no cards.
      const key = name + ' ' + JSON.stringify(args)
      if (!offered.includes(name) || (asked.has(key) && name !== PRESENT_GIFTS.name)) {
        refused++
        answer(`${asked.has(key) ? 'You already have that answer above.' : 'Not at this step.'} ${hint(offered)}`)
        continue
      }
      asked.add(key)

      if (name === PLAN_SCOUT.name) {
        const problems = validate(PLAN_SCOUT.inputSchema, args)
        const plan = args as unknown as Plan
        if (problems.length || !plan.loves.length) {
          step--
          answer('Say at least one thing they love: ' + (problems[0] ?? 'loves is empty'))
          continue
        }
        if (plan.budget_max) state.budget_max = plan.budget_max
        const carried = await carryOut(plan, state.said, runTool)
        if (carried.outage) {
          await o.emit({ t: 'error', text: 'Qloo is not answering right now. The three examples still work.' })
          stopped = true
          break
        }
        if (!carried.text) {
          // Nothing to stand on: say so, and spend no more model calls.
          await o.emit({ t: 'say', text: `Qloo does not know ${carried.unknown.join(' or ')}. Try a favourite artist, author, band, show or brand.` })
          stopped = true
          break
        }
        if (carried.unknown.length) await o.emit({ t: 'say', text: `Qloo does not know ${carried.unknown.join(' or ')}, so these rest on ${carried.known.join(' and ')}.` })
        answer(carried.text)
        continue
      }

      if (name === PRESENT_GIFTS.name) {
        const problems = validate(PRESENT_GIFTS.inputSchema, args)
        if (problems.length) {
          answer('Not shown: ' + problems.slice(0, 4).join('; '))
          continue
        }
        // The lower of what the model set and what the person said.
        const given = [args.budget_max as number | undefined, state.budget_max].filter((b): b is number => b !== undefined)
        const budgetMax = given.length ? Math.min(...given) : undefined
        const proposed = args.ideas ? flattenIdeas(args.ideas as Parameters<typeof flattenIdeas>[0]) : args.cards as ProposedCard[]
        const entityIds = proposed.map((idea) => idea.entity_id).sort()
        if (refusedGiftIds && entityIds.length === refusedGiftIds.length && entityIds.every((id, i) => id === refusedGiftIds![i])) {
          refused++
          answer(`Those are the same ideas again. Choose different ideas and change them as advised: ${refusedGiftFeedbackText}`)
          continue
        }
        const { cards, dropped } = checkCards(proposed, state, budgetMax)
        if (!cards.length) {
          refusedGiftIds = entityIds
          refusedGiftFeedbackText = refusedGiftFeedback(dropped, state, budgetMax)
          answer(refusedGiftFeedbackText)
          await o.emit({ t: 'cards', cards: [], dropped })
          continue
        }
        // Too few kept (most often a third book or podcast): one more try before anything is shown, while there is room.
        const missing = availableKinds(state).filter((kind) => !cards.some((c) => c.entity.type === kind))
        if (cards.length < 5 && missing.length && !retried && modelCalls < MAX_MODEL_CALLS) {
          retried = true
          answer(`Only ${cards.length} kept.${unusedKinds(state, cards)}`)
          continue
        }
        state.cards = cards
        if (budgetMax !== undefined) state.budget_max = budgetMax
        presented = true
        if (o.products) await attachProducts(cards, state, o.products, o.emit, now)
        await o.emit({ t: 'cards', cards, dropped })
        answer(`Shown: ${cards.length} cards.`)
        continue
      }

      if (toolCalls >= MAX_TOOL_CALLS) {
        answer('No more Qloo calls this turn. Call present_gifts now.')
        continue
      }
      answer((await runTool(name, args)).text)
    }

    if (stopped) break
    // A reply made only of refused calls moves straight to presenting.
    if (refused === reply.tool_calls.length) step = steps.length - 1
  }
  if (!modelFailed && !presented && !state.cards.length && !stopped) await o.emit({ t: 'error', text: 'No gift ideas this time. Try saying a little more about them.' })
  await o.emit({ t: 'usage', model_calls: modelCalls, neurons: Math.round(neurons * 10) / 10 })
  if (modelFailed) await o.emit({ t: 'error', text: 'The model did not answer. Try again in a minute.' })
  return state
}
