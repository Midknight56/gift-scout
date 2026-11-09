import type { Budget } from './agent'
import type { ScoutEvent } from './events'
import { neuronsFor, type Model } from './model'
import { QlooError, type EntityType, type QlooClient } from '../qloo/client'
import { nameMatches, otherTypeTag } from '../qloo/tools'
import { plain as displayText } from './text'

export const COMPARE_KINDS = ['brand', 'book', 'artist', 'podcast', 'destination', 'place'] as const
export type CompareKind = (typeof COMPARE_KINDS)[number]
export interface PlainIdea { gift: string; name: string; kind: CompareKind; lookup_name?: string }

// worst case 166 input tokens x 18,182 per million + 1,500 output x 27,273 per million = about 44 neurons,
// under MAX_CALL_NEURONS 135 (src/limits.ts), and the daily caps in src/limits.ts stay under the free
// 10,000 neurons a day, so a compare still costs $0.
export const COMPARE_MAX_TOKENS = 1500

const prompt = 'Give six gift ideas based on what the person says. Return only a JSON array in this exact shape: [{ "gift": "...", "name": "the brand, book, artist, podcast or place to give", "kind": "brand|book|artist|podcast|destination|place" }]. Use six ideas or fewer if needed. Use plain words.'

export function parsePlainIdeas(value: string): PlainIdea[] | null {
  // A small model often wraps the array in a code fence or a sentence: read the outermost [ ... ] only.
  const start = value.indexOf('['), end = value.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try { parsed = JSON.parse(value.slice(start, end + 1)) } catch { return null }
  if (!Array.isArray(parsed) || parsed.length < 1) return null
  const ideas: PlainIdea[] = []
  for (const row of parsed.slice(0, 6)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const idea = row as Record<string, unknown>
    if (typeof idea.gift !== 'string' || typeof idea.name !== 'string' || typeof idea.kind !== 'string') continue
    const gift = idea.gift.trim(), name = idea.name.trim()
    if (gift.length < 1 || gift.length > 160 || name.length < 1 || name.length > 160) continue
    // The model names the maker; Qloo's book or artist search then finds them.
    const kind = idea.kind === 'author' || idea.kind === 'writer' ? 'book'
      : idea.kind === 'band' || idea.kind === 'musician' ? 'artist' : idea.kind
    if (!(COMPARE_KINDS as readonly string[]).includes(kind)) continue
    const displayGift = displayText(gift), displayName = displayText(name)
    if (!displayGift || !displayName) continue
    ideas.push({ gift: displayGift, name: displayName, kind: kind as CompareKind, ...(displayName !== name ? { lookup_name: name } : {}) })
  }
  return ideas.length ? ideas : null
}

type Signals = Omit<Parameters<QlooClient['insights']>[0], 'type' | 'take' | 'resultIds'>

export function firstTurnContexts(turns: ScoutEvent[][]): { kinds: Map<string, Signals>; nearest: Signals } {
  const kinds = new Map<string, Signals>()
  const nearest: Signals = { seedIds: [] }
  const merge = (into: Signals, from: Signals) => {
    into.seedIds = [...new Set([...into.seedIds, ...from.seedIds])]
    for (const key of ['seedTags', 'filterTags'] as const) {
      if (from[key]) into[key] = [...new Set([...(into[key] ?? []), ...from[key]])]
    }
    // Scalar filters cannot be combined in one question; the latest supplied value wins.
    if (from.location !== undefined) into.location = from.location
    if (from.age !== undefined) into.age = from.age
    if (from.gender !== undefined) into.gender = from.gender
  }
  for (const event of turns[0] ?? []) {
    if (event.t !== 'call' || event.tool !== 'taste_insights' || typeof event.args.target_type !== 'string') continue
    const args = event.args
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    const signals: Signals = {
      seedIds: strings(args.seed_ids),
      seedTags: strings(args.seed_tags),
      filterTags: strings(args.filter_tags).filter((tag) => !otherTypeTag(tag, args.target_type as EntityType)),
      ...(typeof args.location === 'string' ? { location: args.location } : {}),
      ...(typeof args.audience_age === 'string' ? { age: args.audience_age as Signals['age'] } : {}),
      ...(typeof args.audience_gender === 'string' ? { gender: args.audience_gender as Signals['gender'] } : {}),
    }
    const kind = args.target_type as string
    const context = kinds.get(kind) ?? { seedIds: [] }
    merge(context, signals)
    kinds.set(kind, context)
    merge(nearest, signals)
  }
  return { kinds, nearest }
}

export async function runCompare(o: {
  message: string; turns: ScoutEvent[][]; cards: { entity: { affinity?: number } }[]; callStart?: number
  qloo: QlooClient; model: Model; budget: Budget; emit(event: ScoutEvent): Promise<void>
}): Promise<void> {
  const held = await o.budget.reserve()
  if (!held) {
    await o.emit({ t: 'error', text: 'Comparing has used its budget for today.' })
    return
  }
  let reply
  try {
    reply = await o.model.chat(
      [{ role: 'system', content: prompt }, { role: 'user', content: o.message }],
      [],
      COMPARE_MAX_TOKENS,
      { reasoningEffort: 'low' },
    )
  } catch (error) {
    console.error('model call failed', error instanceof Error ? error.message : String(error))
    await o.emit({ t: 'error', text: 'The model did not answer. Try again in a minute.' })
    return
  }
  const spent = reply.neurons ?? neuronsFor(reply.prompt_tokens, reply.completion_tokens)
  await held.settle(spent)
  const ideas = parsePlainIdeas(reply.content)
  if (reply.cut || !ideas) {
    console.error('compare reply cut', reply.cut ? 'length' : 'stop', 'content length', reply.content.length)
    await o.emit({ t: 'error', text: 'The model did not give gift ideas in the right shape.' })
    return
  }
  let calls = o.callStart ?? 0
  const contexts = firstTurnContexts(o.turns)
  const plain: Extract<ScoutEvent, { t: 'compare' }>['plain'] = []
  const qlooMeans = o.cards.map((card) => card.entity.affinity).filter((score): score is number => typeof score === 'number' && Number.isFinite(score))
  const call = async (tool: string, args: Record<string, unknown>, operation: () => Promise<{ results: import('../qloo/client').Entity[]; cached: boolean }>) => {
    const n = ++calls
    await o.emit({ t: 'call', n, tool, args })
    const started = Date.now()
    try {
      const answer = await operation()
      await o.emit({ t: 'result', n, tool, ok: true, ms: Date.now() - started, cached: answer.cached, text: answer.results.length ? answer.results.map((e) => `${e.name}${e.affinity === undefined ? '' : ` (affinity ${e.affinity.toFixed(2)})`} id ${e.id}`).join('\n') : 'Not found in Qloo.', top: answer.results.slice(0, 8).map((e) => ({ id: e.id, name: e.name, type: e.type, ...(e.affinity === undefined ? {} : { affinity: e.affinity }), tags: e.tags })) })
      return answer.results
    } catch (error) {
      const text = error instanceof QlooError ? error.message : 'Qloo is not answering right now.'
      await o.emit({ t: 'result', n, tool, ok: false, ms: Date.now() - started, cached: false, text, top: [] })
      return []
    }
  }
  for (const idea of ideas) {
    const type = idea.kind as EntityType
    const context = contexts.kinds.has(type) ? 'same' : 'nearest'
    const signals = contexts.kinds.get(type) ?? contexts.nearest
    const lookupName = idea.lookup_name ?? idea.name
    const hits = await call('search_entities', { query: lookupName, type, take: 1 }, () => o.qloo.search(lookupName, type, 1))
    const hit = hits[0]
    if (!hit || hit.type !== type || !nameMatches(hit.name, lookupName, type)) { plain.push({ ...idea, context, found: false }); continue }
    const args = {
      seed_ids: signals.seedIds, seed_tags: signals.seedTags, filter_tags: signals.filterTags,
      location: signals.location, audience_age: signals.age, audience_gender: signals.gender,
      target_type: type, result_ids: [hit.id], take: 1,
    }
    const scored = await call('taste_insights', args, () => o.qloo.insights({ ...signals, type, resultIds: [hit.id], take: 1 }))
    const match = scored.find((entity) => entity.id === hit.id && entity.type === type && nameMatches(entity.name, hit.name, type))
    plain.push(match ? { ...idea, context, found: true, matched: { id: hit.id, name: hit.name, type: hit.type }, ...(match.affinity === undefined ? {} : { affinity: match.affinity }) } : { ...idea, context, found: false })
  }
  const scores = plain.flatMap((idea) => idea.found && typeof idea.affinity === 'number' ? [idea.affinity] : [])
  const mean = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 1000) / 1000 : null
  await o.emit({ t: 'compare', plain, plain_mean: mean(scores), qloo_mean: mean(qlooMeans), not_found: plain.filter((idea) => !idea.found).length,
    coverage: { plain_found: plain.filter((idea) => idea.found).length, plain_total: plain.length, cards_scored: qlooMeans.length, cards_total: o.cards.length },
  })
  await o.emit({ t: 'usage', model_calls: 1, neurons: Math.round(spent * 10) / 10 })
}

