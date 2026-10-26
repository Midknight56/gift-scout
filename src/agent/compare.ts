import type { Budget } from './agent'
import type { ScoutEvent } from './events'
import { neuronsFor, type Model } from './model'
import { QlooError, type EntityType, type QlooClient } from '../qloo/client'
import { pronounsFromMessage } from './pronouns'

export const COMPARE_KINDS = ['brand', 'book', 'artist', 'podcast', 'destination', 'place'] as const
export type CompareKind = (typeof COMPARE_KINDS)[number]
export interface PlainIdea { gift: string; name: string; kind: CompareKind }

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
    ideas.push({ gift, name, kind: kind as CompareKind })
  }
  return ideas.length ? ideas : null
}

export function firstTurnSeedIds(turns: ScoutEvent[][]): string[] {
  const first = turns[0] ?? []
  const ids: string[] = []
  for (const event of first) {
    if (event.t !== 'call' || event.tool !== 'taste_insights') continue
    const seeds = event.args.seed_ids
    if (Array.isArray(seeds)) for (const id of seeds) if (typeof id === 'string' && id.length) ids.push(id)
  }
  return [...new Set(ids)]
}

export async function runCompare(o: {
  message: string; seedIds: string[]; cards: { entity: { affinity?: number } }[]; callStart?: number
  qloo: QlooClient; model: Model; budget: Budget; emit(event: ScoutEvent): Promise<void>
}): Promise<void> {
  const held = await o.budget.reserve()
  if (!held) {
    await o.emit({ t: 'error', text: 'Comparing has used its budget for today.' })
    return
  }
  let reply
  try { reply = await o.model.chat([{ role: 'system', content: prompt }, { role: 'user', content: o.message }], [], 900) }
  catch {
    await o.emit({ t: 'error', text: 'The model did not answer. Try again in a minute.' })
    return
  }
  const spent = reply.neurons ?? neuronsFor(reply.prompt_tokens, reply.completion_tokens)
  await held.settle(spent)
  const ideas = parsePlainIdeas(reply.content)
  if (!ideas) {
    await o.emit({ t: 'error', text: 'The model did not give gift ideas in the right shape.' })
    return
  }
  let calls = o.callStart ?? 0
  const pronoun = pronounsFromMessage(o.message)
  const gender = pronoun === 'he' ? 'male' : pronoun === 'she' ? 'female' : undefined
  const plain: { gift: string; name: string; kind: string; found: boolean; affinity?: number }[] = []
  const qlooMeans = o.cards.map((card) => card.entity.affinity).filter((score): score is number => typeof score === 'number')
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
    const hits = await call('search_entities', { query: idea.name, type, take: 1 }, () => o.qloo.search(idea.name, type, 1))
    const hit = hits[0]
    if (!hit) { plain.push({ ...idea, found: false }); continue }
    const args = { seed_ids: o.seedIds, target_type: type, result_ids: [hit.id], take: 1, ...(gender ? { audience_gender: gender } : {}) }
    const scored = await call('taste_insights', args, () => o.qloo.insights({ seedIds: o.seedIds, type, resultIds: [hit.id], take: 1, gender }))
    const match = scored.find((entity) => entity.id === hit.id)
    plain.push(match ? { ...idea, found: true, ...(match.affinity === undefined ? {} : { affinity: match.affinity }) } : { ...idea, found: false })
  }
  const scores = plain.flatMap((idea) => idea.found && typeof idea.affinity === 'number' ? [idea.affinity] : [])
  const mean = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 1000) / 1000 : null
  await o.emit({ t: 'compare', plain, plain_mean: mean(scores), qloo_mean: mean(qlooMeans), not_found: plain.filter((idea) => !idea.found).length })
  await o.emit({ t: 'usage', model_calls: 1, neurons: Math.round(spent * 10) / 10 })
}

