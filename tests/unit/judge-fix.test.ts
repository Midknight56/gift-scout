import { describe, expect, it, vi } from 'vitest'
import { newState, runTurn, type Budget } from '../../src/agent/agent'
import type { ScoutEvent } from '../../src/agent/events'
import { WorkersAiModel, type ChatMessage, type Model, type ModelReply, type ToolCall } from '../../src/agent/model'
import { carryOut, type Plan } from '../../src/agent/plan'
import { nameSaidIn, wordSaidIn } from '../../src/agent/text'
import { QlooClient, type Cache } from '../../src/qloo/client'
import { nameMatches, qlooTools } from '../../src/qloo/tools'

let callId = 0
function call(name: string, args: unknown): ToolCall {
  return { id: 'c' + ++callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
function reply(calls: ToolCall[]): ModelReply {
  return { content: '', tool_calls: calls, prompt_tokens: 1000, completion_tokens: 100, cut: false }
}
function scripted(replies: ModelReply[]): Model & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  return { name: 'scripted', seen, async chat(messages) {
    seen.push(structuredClone(messages))
    const r = replies.shift(); if (!r) throw new Error('no more replies'); return r
  } }
}
function budget(): Budget {
  return { allow: async () => true, reserve: async () => ({ settle: async () => {} }) }
}
const entity = (name: string, type = 'artist', id = '00000000-0000-4000-8000-000000000001') => ({ entity_id: id, name, types: ['urn:entity:' + type] })
function qloo(answer?: (url: URL) => unknown) {
  const asked: URL[] = []
  const m = new Map<string, string>()
  const cache: Cache = { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) } }
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); asked.push(url)
    const query = url.searchParams.get('query') ?? url.searchParams.get('filter.query') ?? ''
    const body = answer?.(url) ?? (url.pathname === '/search' ? { results: [entity(query)] }
      : url.pathname === '/v2/tags' ? { results: { tags: [{ id: 'urn:tag:interests:' + query, name: query, type: 'urn:tag:interests', parents: [] }] } }
        : { results: { entities: [] } })
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { ctx: { qloo: new QlooClient('k', fetcher, cache, async () => true) }, asked }
}
async function turn(message: string, loves: Plan['loves'], answer?: (url: URL) => unknown, city?: string) {
  const model = scripted([reply([call('plan_scout', { loves, ...(city ? { city } : {}) })]), reply([]), reply([])])
  const { ctx, asked } = qloo(answer)
  const events: ScoutEvent[] = []
  const state = await runTurn({ message, state: newState('judge'), model, ctx, tools: qlooTools(), budget: budget(), emit: (e) => { events.push(e) } })
  const searches = events.filter((e) => e.t === 'call' && ['search_entities', 'search_tags'].includes(e.tool))
  return { model, asked, events, state, searches }
}

describe('live judge plan regressions', () => {
  it('returns no text, unknown or outage when no love was said, across all conversation messages', async () => {
    const calls: string[] = []
    const result = await carryOut({ loves: [{ name: 'Phoebe Bridgers', kind: 'named' }] }, ['My dad.', 'Make it cheaper'], async (tool) => {
      calls.push(tool)
      return { ok: true, text: '', top: [] }
    })
    expect(calls).toEqual([])
    expect(result).toEqual({ text: '', unknown: [], known: [], outage: false })
  })

  it('matches significant stemmed words across the conversation, excluding generic and short words', () => {
    for (const [love, said] of [['running', 'runs'], ['gardening', 'garden'], ['runners', 'running'], ['painted', 'paint'], ['watches', 'watch'], ['CARRÉ novels', 'Carre']]) {
      expect(wordSaidIn(love, ['My dad.', said])).toBe(true)
    }
    for (const love of ['the', 'and', 'for', 'with', 'from', 'food', 'music', 'book', 'books', 'gift', 'gifts', 'love', 'loves', 'ab', '123', 'ab12']) {
      expect(wordSaidIn(love + ' Phoebe', [love + ' Khruangbin'])).toBe(false)
    }
  })

  it('asks for loves without any Qloo calls when the plan invents all of them', async () => {
    const { model, events, asked, state } = await turn('Make it cheaper', [
      { name: 'Phoebe Bridgers', kind: 'named' }, { name: 'Korean food', kind: 'cuisine' }, { name: 'running', kind: 'hobby' },
    ])
    expect(events.filter((e) => e.t === 'call')).toEqual([])
    expect(asked).toEqual([])
    expect(events.filter((e) => e.t === 'say')).toEqual([{ t: 'say', text: 'Tell me a couple of things they love, like a favourite author, band, show or brand.' }])
    expect(events.some((e) => e.t === 'cards' || e.t === 'error')).toBe(false)
    expect(state.cards).toEqual([])
    expect(model.seen).toHaveLength(1)
  })

  it('searches running said as runs and both named loves', async () => {
    const { searches } = await turn('A friend who runs. Haruki Murakami and the band Khruangbin. Something to do together.', [
      { name: 'running', kind: 'hobby' }, { name: 'Haruki Murakami', kind: 'named' }, { name: 'Khruangbin', kind: 'named' },
    ])
    expect(searches).toMatchObject([
      { tool: 'search_tags', args: { query: 'running' } },
      { tool: 'search_entities', args: { query: 'Haruki Murakami' } },
      { tool: 'search_entities', args: { query: 'Khruangbin' } },
    ])
  })

  it('searches an expanded accented author name and the drink the person said', async () => {
    const { searches } = await turn('My dad. Le Carre novels and single malt. Christmas.', [
      { name: 'John le Carré', kind: 'named' }, { name: 'single malt', kind: 'drink' },
    ])
    expect(searches).toMatchObject([
      { tool: 'search_entities', args: { query: 'John le Carré' } },
      { tool: 'search_entities', args: { query: 'single malt', type: 'brand' } },
    ])
  })

  it('searches only gardening and does not report an invented love as unknown', async () => {
    const { searches, events, model } = await turn('My mom loves gardening.', [
      { name: 'gardening', kind: 'hobby' }, { name: 'Phoebe Bridgers', kind: 'named' },
    ])
    expect(searches).toMatchObject([{ tool: 'search_tags', args: { query: 'gardening' } }])
    expect(events.filter((e) => e.t === 'say').some((e) => e.text.includes('Phoebe Bridgers'))).toBe(false)
    expect(model.seen[1].at(-1)?.content).not.toContain('Qloo does not know')
  })

  it('retries a named love without its trailing medium and seeds with the matching person', async () => {
    const personId = '00000000-0000-4000-8000-000000000002'
    const { searches, events, asked, model } = await turn('She loves Agatha Christie mysteries.', [{ name: 'Agatha Christie mysteries', kind: 'named' }], (url) => {
      if (url.pathname !== '/search') return { results: { entities: [] } }
      return { results: [url.searchParams.get('query') === 'Agatha Christie'
        ? entity('Agatha Christie', 'person', personId)
        : entity('Agatha Christie: The Woman and Her Mysteries', 'book')] }
    })
    expect(searches).toMatchObject([
      { tool: 'search_entities', args: { query: 'Agatha Christie mysteries' } },
      { tool: 'search_entities', args: { query: 'Agatha Christie' } },
    ])
    const insights = asked.filter((u) => u.pathname === '/v2/insights')
    expect(insights).toHaveLength(4)
    expect(insights.every((u) => u.searchParams.get('signal.interests.entities') === personId)).toBe(true)
    expect(events.filter((e) => e.t === 'say').some((e) => e.text.includes('Qloo does not know'))).toBe(false)
    expect(model.seen[1].at(-1)?.content).not.toContain('Qloo does not know')
  })
})

describe('live judge name regressions', () => {
  it('matches standalone number words and digits', () => {
    expect(nameMatches('Formula One', 'Formula 1')).toBe(true)
    for (const [i, word] of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].entries()) {
      expect(nameMatches('Formula ' + word, 'Formula ' + (i + 1))).toBe(true)
      expect(nameMatches('Formula ' + (i + 1), 'Formula ' + word)).toBe(true)
    }
    expect(nameMatches('Someone', 'Some1')).toBe(false)
  })
  it('matches letters that NFD does not split', () => {
    expect(nameMatches('Eivør', 'Eivor')).toBe(true)
    for (const [letter, folded] of [['ø', 'o'], ['æ', 'ae'], ['œ', 'oe'], ['ß', 'ss'], ['ł', 'l'], ['đ', 'd'], ['ð', 'd'], ['þ', 'th']]) {
      expect(nameMatches(letter, folded)).toBe(true)
      expect(nameMatches(letter.toUpperCase(), folded)).toBe(true)
    }
  })
})

describe('Workers AI model call timeout', () => {
  it('rejects a model call that does not resolve within its configured limit', async () => {
    const model = new WorkersAiModel({ run: () => new Promise(() => {}) }, 20)
    const result = await Promise.race([
      model.chat([], [], 100).then(() => 'answered', (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 1000)),
    ])
    expect(result).toBe('The model took too long.')
  })

  it('ends the turn with the model error and makes no Qloo call', async () => {
    const model = new WorkersAiModel({ run: () => new Promise(() => {}) }, 20)
    const { ctx, asked } = qloo()
    const events: ScoutEvent[] = []
    await runTurn({ message: 'My dad. Le Carre novels and single malt. Christmas.', state: newState('judge'), model, ctx, tools: qlooTools(), budget: budget(), emit: (e) => { events.push(e) } })
    expect(events.filter((e) => e.t === 'error')).toEqual([{ t: 'error', text: 'The model did not answer. Try again in a minute.' }])
    expect(asked).toEqual([])
  })

  it('returns a normal answer and clears the timeout after a fast response', async () => {
    vi.useFakeTimers()
    try {
      const raw = { choices: [{ message: { content: 'Hello' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
      const model = new WorkersAiModel({ run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return raw
      } }, 1000)
      const pending = model.chat([], [], 100)
      await vi.advanceTimersByTimeAsync(5)
      await expect(pending).resolves.toMatchObject({ content: 'Hello', tool_calls: [] })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('album seed and named city regressions', () => {
  it('treats an album result for a named love as unknown and never uses it as a seed', async () => {
    const albumId = '00000000-0000-4000-8000-000000000024'
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    const result = await carryOut({ loves: [{ name: 'Eivor', kind: 'named' }] }, ['My cousin loves the singer Eivor and walks in the forest.'], async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'search_entities') return { ok: true, text: '', top: [{ id: albumId, name: 'Eivor', type: 'album' }] }
      return { ok: true, text: '', top: [] }
    })
    expect(calls.filter((call) => call.tool === 'taste_insights').every((call) => !JSON.stringify(call.args).includes(albumId))).toBe(true)
    expect(result.unknown).toEqual(['Eivor'])
    const live = await turn('My cousin loves the singer Eivor and walks in the forest.', [{ name: 'Eivor', kind: 'named' }], (url) => url.pathname === '/search'
      ? { results: [entity('EivÃ¸r', 'album', albumId)] }
      : { results: { entities: [] } })
    expect(live.events.find((event) => event.t === 'say')?.text).toContain('Qloo does not know Eivor')
  })

  it.each([
    ['She lives in Toronto.', 'Toronto', true],
    ['He lives in New York.', 'New York', true],
    ['walks in the forest', 'forest', false],
    ['she lives in toronto', 'toronto', false],
  ])('uses city %s only when it is written as a name', async (message, city, shouldAskPlace) => {
    const { asked } = await turn(message + ' Phoebe Bridgers is her favorite.', [{ name: 'Phoebe Bridgers', kind: 'named' }], undefined, city)
    expect(asked.some((url) => url.pathname === '/v2/insights' && url.searchParams.get('filter.type') === 'urn:entity:place')).toBe(shouldAskPlace)
  })

  it('matches capitalized city names by whole words, ignoring case and accents for matching', () => {
    expect(nameSaidIn('Toronto', ['She lives in Toronto.'])).toBe(true)
    expect(nameSaidIn('New York', ['He lives in New York.'])).toBe(true)
    expect(nameSaidIn('forest', ['walks in the forest'])).toBe(false)
    expect(nameSaidIn('toronto', ['she lives in toronto'])).toBe(false)
  })
})
