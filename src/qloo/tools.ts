// Qloo as MCP tools, so any agent can use the taste graph: resolve a person's loves to Qloo entities and tags, then ask
// what else that audience loves, in the category a gift could come from. Every result carries Qloo's own affinity
// score, so an agent can say why it picked something and a person can check it.
import type { Tool, ToolResult } from '../mcp/server'
import { AGES, ENTITY_TYPES, GENDERS, QlooError, TAG_ID, type Entity, type EntityType, type QlooClient, type Tag } from './client'

export interface QlooContext { qloo: QlooClient }

const ID = { type: 'string', minLength: 8, maxLength: 64, description: 'A Qloo entity id from search_entities.' } as const
const TAG = { type: 'string', pattern: TAG_ID.source, description: 'A Qloo tag id from search_tags.' } as const

/** Short on purpose: these lines go back into the model, and every token is paid for. */
export function entityLine(e: Entity): string {
  const score = e.affinity !== undefined ? ` (affinity ${e.affinity.toFixed(2)})` : ''
  const detail = e.detail ? ': ' + (e.detail.length > 90 ? e.detail.slice(0, 87) + '...' : e.detail) : ''
  return `${e.name}${score} [${e.type}] id ${e.id}${detail}`
}

function tagLine(t: Tag): string {
  return `${t.name} [${t.kind}] for ${t.for.join(', ') || 'any'} id ${t.id}`
}

/** True when a tag id names an entity type other than the target, like `urn:tag:genre:place:restaurant:korean` for brands. */
export function otherTypeTag(tag: string, target: EntityType): boolean {
  const parts = tag.split(':')
  return ENTITY_TYPES.some((t) => t !== target && parts.includes(t))
}

const PEOPLE = ['author', 'person', 'artist']

function fold(s: string): string {
  const letters: Record<string, string> = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th' }
  return s.replace(/[øæœßłđðþ]/giu, (letter) => letters[letter.toLowerCase()])
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** True when a found name is the name asked for: equal, or one holds the other and is at least half its length. */
export function nameMatches(name: string, query: string): boolean {
  const numbers: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' }
  const numbered = (s: string) => fold(s).replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (word) => numbers[word])
  const n = numbered(name)
  const q = numbered(query)
  if (!n || !q) return false
  return n === q || (n.includes(q) && q.length * 2 >= n.length) || (q.includes(n) && n.length * 2 >= q.length)
}

function failed(e: unknown): ToolResult {
  if (e instanceof QlooError) return { content: [{ type: 'text', text: e.message }], isError: true }
  throw e
}

export const searchEntities: Tool<QlooContext> = {
  name: 'search_entities',
  title: 'Find a taste in Qloo',
  description:
    'Turns something a person loves (an author, an artist, a band, a brand, a drink, a book, a show, a game) into a ' +
    'Qloo entity id. Leave out type: Qloo puts the best match first, and an author comes back as an author. Do not ' +
    'search a city: give it as the location of taste_insights.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 120, description: 'The name, for example "Phoebe Bridgers".' },
      type: { type: 'string', enum: ENTITY_TYPES, description: 'Only when the name is ambiguous.' },
      take: { type: 'integer', minimum: 1, maximum: 5, description: 'How many matches to return (default 1, the best).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args, ctx) {
    const query = args.query as string
    // One by default: given three matches, the model passed all three as seeds (three "Phoebe Bridgers" entities).
    const take = (args.take as number | undefined) ?? 1
    try {
      // "Korean food" is a cuisine, not a named thing: measured 23 Oct 2026, searching it as an entity found a
      // restaurant called "Korean food CONAMU". It is answered with the cuisine's tags, as search_tags would.
      const cuisine = /^(.{3,40}?)\s+(food|cuisine|cooking)$/i.exec(query.trim())
      if (cuisine && !args.type) {
        const tags = await ctx.qloo.tags(cuisine[1], 3)
        if (tags.results.length) {
          const text = 'That is a cuisine, so here are its tags:\n' + tags.results.map(tagLine).join('\n')
          return { content: [{ type: 'text', text }], structuredContent: { query, kind: 'tags', cached: tags.cached, results: tags.results } }
        }
      }
      let { results, cached } = await ctx.qloo.search(query, args.type as EntityType | undefined, take)
      // A typed search whose best answer is not the name asked for ("Le Carre" as a book gave a Wheel of Time novel;
      // "Haruki Murakami" as a book gave a reader's guide) is asked again with no type, and a true match goes first.
      if (args.type && !nameMatches(results[0]?.name ?? '', query)) {
        const any = await ctx.qloo.search(query, undefined, take)
        const best = any.results[0]
        // Only a person is taken from the untyped search: "single malt" as a brand gave Lagavulin, and untyped gave a
        // novel called "Single Malt Apocalypse" (measured 23 Oct 2026).
        if (best && PEOPLE.includes(best.type) && nameMatches(best.name, query)) {
          results = [best, ...results.filter((r) => r.id !== best.id)].slice(0, take)
          cached = cached && any.cached
        }
      }
      const text = results.length ? results.map(entityLine).join('\n') : `Qloo knows nothing called "${query}".`
      return { content: [{ type: 'text', text }], structuredContent: { query, type: args.type ?? null, cached, results } }
    } catch (e) { return failed(e) }
  },
}

export const searchTags: Tool<QlooContext> = {
  name: 'search_tags',
  title: 'Find a taste that is not one thing',
  description:
    'Turns a cuisine, a hobby or a genre (for example "Korean", "running", "jazz") into Qloo tag ids. Use a tag as a ' +
    'seed in taste_insights, or as a filter there (a cuisine tag with places finds restaurants of that cuisine).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 60, description: 'One word or two, for example "Korean".' },
      take: { type: 'integer', minimum: 1, maximum: 10, description: 'How many tags to return (default 3).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args, ctx) {
    try {
      const { results, cached } = await ctx.qloo.tags(args.query as string, (args.take as number | undefined) ?? 3)
      const text = results.length ? results.map(tagLine).join('\n') : `Qloo has no tag for "${args.query}".`
      return { content: [{ type: 'text', text }], structuredContent: { query: args.query, cached, results } }
    } catch (e) { return failed(e) }
  },
}

export const tasteInsights: Tool<QlooContext> = {
  name: 'taste_insights',
  title: 'What else they love',
  description:
    'Given what a person loves (entity ids from search_entities, tag ids from search_tags, or both), returns the ' +
    'entities of one type that the same audience loves most, each with an affinity score from 0 to 1. Give a city ' +
    'with type "place" to stay near them, and filter_tags to keep only places of a cuisine or a kind.',
  inputSchema: {
    type: 'object',
    properties: {
      seed_ids: { type: 'array', items: ID, maxItems: 5, description: 'Entity ids from search_entities.' },
      seed_tags: { type: 'array', items: TAG, maxItems: 3, description: 'Tag ids from search_tags, used as tastes.' },
      target_type: { type: 'string', enum: ENTITY_TYPES, description: 'The kind of thing to suggest.' },
      location: { type: 'string', minLength: 2, maxLength: 80, description: 'A city, used for places only.' },
      filter_tags: { type: 'array', items: TAG, maxItems: 3, description: 'Only return entities with these tags.' },
      audience_age: { type: 'string', enum: AGES, description: 'The age range of the person, only if known.' },
      audience_gender: { type: 'string', enum: GENDERS, description: 'Only if plain from what was said (a dad, a sister).' },
      take: { type: 'integer', minimum: 1, maximum: 15, description: 'How many to return (default 6).' },
    },
    required: ['target_type'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args, ctx) {
    const seedIds = (args.seed_ids as string[] | undefined) ?? []
    const seedTags = (args.seed_tags as string[] | undefined) ?? []
    if (!seedIds.length && !seedTags.length) {
      return { content: [{ type: 'text', text: 'Give at least one seed id from search_entities or a tag from search_tags.' }], isError: true }
    }
    // A filter tag made for another kind of entity (a restaurant tag on a brand question) empties the answer: measured
    // 23 Oct 2026, brands for Phoebe Bridgers with the Korean restaurant tag as a filter came back with none. Such a tag
    // is left out of the filter, not refused, so the rest of the call still works.
    const target = args.target_type as EntityType
    const filterTags = ((args.filter_tags as string[] | undefined) ?? []).filter((t) => !otherTypeTag(t, target))
    try {
      const { results, cached } = await ctx.qloo.insights({
        seedIds, seedTags, filterTags, type: target,
        location: args.location as string | undefined, take: (args.take as number | undefined) ?? 6,
        age: args.audience_age as (typeof AGES)[number] | undefined, gender: args.audience_gender as (typeof GENDERS)[number] | undefined,
      })
      const text = results.length ? results.map((entity) => {
        const shares = (entity.shares ?? []).map(({ id, share }) => `${id} ${Math.round(share * 100)}%`).join(', ')
        const score = entity.affinity !== undefined ? `, affinity ${entity.affinity.toFixed(2)}` : ''
        const from = shares ? `, mostly from ${shares.split(', ')[0]}` : ''
        return `${entity.name} (${entity.type}${score}${from}) id ${entity.id}`
      }).join('\n') : `Qloo found no ${args.target_type} for those seeds.`
      return {
        content: [{ type: 'text', text }],
        structuredContent: { seed_ids: seedIds, seed_tags: seedTags, target_type: args.target_type, location: args.location ?? null, cached, results },
      }
    } catch (e) { return failed(e) }
  },
}

export function qlooTools(): Tool<QlooContext>[] { return [searchEntities, searchTags, tasteInsights] }
