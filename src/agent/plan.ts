// The first turn's plan. The model reads the person's message once and names what they love, each with its kind; code
// then asks Qloo the same questions every time: one search per love, then the taste graph for every kind of gift, all
// seeds together. Measured 23 Oct 2026: left to choose its own calls, the model skipped the city and the cuisine on one
// run of the same message and covered them on the next. With a plan, every run asks Qloo the full set.
import type { JsonSchema } from '../mcp/schema'
import { AGES, GENDERS } from '../qloo/client'
import { nameMatches } from '../qloo/tools'
import type { Found } from './events'
import { saidIn, wordSaidIn } from './text'

export const LOVE_KINDS = ['named', 'drink', 'cuisine', 'hobby'] as const
export type LoveKind = (typeof LOVE_KINDS)[number]

export interface Plan {
  loves: { name: string; kind: LoveKind }[]
  city?: string
  budget_max?: number
  gender?: (typeof GENDERS)[number]
  age?: (typeof AGES)[number]
}

export const PLAN_SCOUT: { name: string; description: string; inputSchema: JsonSchema } = {
  name: 'plan_scout',
  description:
    'Say what the person loves, so Gift Scout can ask Qloo. Call it once, first. Gift Scout answers with what Qloo ' +
    'found for every kind of gift.',
  inputSchema: {
    type: 'object',
    properties: {
      loves: {
        type: 'array',
        maxItems: 5,
        description: 'Each thing they love, as they said it.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 80, description: 'The thing itself in one to four words: "Phoebe Bridgers", "Korean food", "single malt", "running" (not "a friend who runs").' },
            kind: {
              type: 'string', enum: LOVE_KINDS,
              description: 'named: an author, artist, band, show, book or brand. drink: a drink. cuisine: a food. hobby: an activity.',
            },
          },
          required: ['name', 'kind'],
          additionalProperties: false,
        },
      },
      city: { type: 'string', minLength: 2, maxLength: 80, description: 'Their city, only if they named one.' },
      budget_max: { type: 'integer', minimum: 1, maximum: 5000, description: 'The most to spend in US dollars, only if they said.' },
      gender: { type: 'string', enum: GENDERS, description: 'Only when plain from what they said: a dad, a son, a husband are male; a mom, a sister, a wife are female. Otherwise leave it out.' },
      age: { type: 'string', enum: AGES, description: 'Only when they gave an age or it is plain (a grandparent is 55_and_older). Otherwise leave it out.' },
    },
    required: ['loves'],
    additionalProperties: false,
  },
}

/** The kinds of gift every first turn asks Qloo about; place only with a city. */
export const GIFT_KINDS = ['brand', 'book', 'podcast', 'destination'] as const

/** What one tool call gave back, as the plan needs it. */
export interface Ran { ok: boolean; text: string; top: Found[] }
export type RunTool = (tool: string, args: Record<string, unknown>) => Promise<Ran>

/** "Korean food" asks Qloo's tags for "Korean". */
function cuisineWord(name: string): string {
  return name.replace(/\b(food|cuisine|cooking|dishes|restaurants?)\b/gi, '').replace(/\s+/g, ' ').trim() || name
}

/** A cuisine tag that describes restaurants filters places to that cuisine; measured best: genre:place:restaurant. */
function restaurantTag(tags: Found[]): string | undefined {
  return (tags.find((t) => t.id.includes(':restaurant:')) ?? tags.find((t) => t.id.includes(':cuisine:')) ?? tags[0])?.id
}

/** What carrying out a plan gave: the text the model reads next, the loves Qloo did not know, and whether Qloo
 *  answered at all. */
export interface Carried { text: string; unknown: string[]; known: string[]; outage: boolean }

/** Runs the plan's Qloo calls through `run` (each one shows in the panel). */
export async function carryOut(plan: Plan, said: string[], run: RunTool): Promise<Carried> {
  const loves = plan.loves.slice(0, 5).filter((love) => saidIn(love.name, said) || wordSaidIn(love.name, said))
  const queries = loves.map((love) => love.name)
  const found = await Promise.all(loves.map(async (love, i) => {
    if (love.kind === 'named') {
      const first = await run('search_entities', { query: love.name })
      if (first.ok && !nameMatches(first.top[0]?.name ?? '', love.name)) {
        const shorter = love.name.trim().replace(/\s+(?:novels?|books?|mysteries|mystery|records?|albums?|music|films?|movies?|shows?|series|podcasts?|games?)$/i, '')
        if (shorter !== love.name.trim()) {
          const retry = await run('search_entities', { query: shorter })
          if (retry.ok && nameMatches(retry.top[0]?.name ?? '', shorter)) {
            queries[i] = shorter
            return retry
          }
        }
      }
      return first
    }
    if (love.kind === 'drink') return run('search_entities', { query: love.name, type: 'brand' })
    if (love.kind === 'cuisine') return run('search_tags', { query: cuisineWord(love.name) })
    return run('search_tags', { query: love.name })
  }))
  // Every search failing is Qloo not answering, not Qloo not knowing.
  if (found.length && found.every((f) => !f.ok)) return { text: '', unknown: [], known: [], outage: true }
  const seedIds: string[] = []
  const seedTags: string[] = []
  const unknown: string[] = []
  const known: string[] = []
  let cuisine: string | undefined
  loves.forEach((love, i) => {
    const top = found[i].ok ? found[i].top : []
    // Qloo answers a search with its nearest match for almost any name; a named love whose best match is not that
    // name is a love Qloo does not know, and is not used as a seed.
    if (!top.length || (love.kind === 'named' && !nameMatches(top[0].name, queries[i]))) { unknown.push(love.name); return }
    known.push(top[0].type === 'tag' ? love.name : top[0].name)
    if (top[0].type === 'tag') {
      const tag = love.kind === 'cuisine' ? restaurantTag(top) : top[0].id
      if (tag && !seedTags.includes(tag)) seedTags.push(tag)
      if (love.kind === 'cuisine' && !cuisine) cuisine = tag
    } else if (!seedIds.includes(top[0].id)) seedIds.push(top[0].id)
  })
  if (!seedIds.length && !seedTags.length) return { text: '', unknown, known, outage: false }

  const city = plan.city && saidIn(plan.city, said) ? plan.city : undefined
  const base = {
    ...(seedIds.length ? { seed_ids: seedIds.slice(0, 5) } : {}),
    ...(seedTags.length ? { seed_tags: seedTags.slice(0, 3) } : {}),
    // Who the gift is for, as Qloo's audience signals, when the message made it plain.
    ...(plan.age && (AGES as readonly string[]).includes(plan.age) ? { audience_age: plan.age } : {}),
    ...(plan.gender && (GENDERS as readonly string[]).includes(plan.gender) ? { audience_gender: plan.gender } : {}),
  }
  const asks: Record<string, unknown>[] = GIFT_KINDS.map((k) => ({ ...base, target_type: k, take: 6 }))
  if (city) asks.push({ ...base, target_type: 'place', location: city, ...(cuisine ? { filter_tags: [cuisine] } : {}), take: 6 })
  const answers = await Promise.all(asks.map((a) => run('taste_insights', a)))
  if (answers.every((a) => !a.ok)) return { text: '', unknown, known, outage: true }
  const lead = unknown.length ? `Qloo does not know ${unknown.join(' or ')}; these rest on ${known.join(' and ')}.\n\n` : ''
  return { text: lead + asks.map((a, i) => `${String(a.target_type).toUpperCase()}:\n${answers[i].text}`).join('\n\n'), unknown, known, outage: false }
}
