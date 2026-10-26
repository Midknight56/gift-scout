// POST /api/scout: one turn of the conversation, streamed to the page as NDJSON (see src/agent/events.ts).
// A turn is served in the cheapest honest way it can be:
//   cache   the same first message was answered live before: its saved turn is sent again, 0 neurons, 0 Qloo calls;
//   live    the agent runs on Workers AI and Qloo, inside the daily caps;
//   replay  live is not possible (no Qloo key, the AI budget spent, the visitor's cap reached) and the message is one
//           of the three examples: the run recorded for it is sent, labelled as recorded with its date.
// Otherwise the turn ends with a calm line saying why. Every mode says which it is in the `run` event.
import { newState, runTurn, type Budget, type ConversationState } from '../agent/agent'
import type { ScoutEvent } from '../agent/events'
import type { Model } from '../agent/model'
import type { SearchResult } from '../channel3/client'
import type { Tool } from '../mcp/server'
import type { QlooContext } from '../qloo/tools'
import { normalizeRequest, runKey, type Conversations, type RunCache } from '../store/d1'

/** The three demo runs from the build brief. The page offers them as chips. */
export const EXAMPLES = [
  'My sister. She loves Phoebe Bridgers and Korean food. She lives in Toronto. Birthday, under 60 dollars.',
  'My dad. Le Carre novels and single malt. Christmas.',
  'A friend who runs. Haruki Murakami and the band Khruangbin. Something to do together.',
]

/** A recorded run: what the agent did live for one example, kept so the page works with no key and no budget.
 *  `turns[i]` is what turn i+1 sent and `states[i]` the conversation after it; `states.at(-1).said` holds the messages. */
export interface RecordedRun { recorded_at: string; turns: ScoutEvent[][]; states: ConversationState[] }

/** The recorded turn that answers this message after these earlier messages, if there is one. */
export function findRecorded(recorded: RecordedRun[], earlier: string[], message: string): { run: RecordedRun; index: number } | null {
  const want = [...earlier, message].map(normalizeRequest)
  for (const run of recorded) {
    const said = (run.states.at(-1)?.said ?? []).map(normalizeRequest)
    if (said.length >= want.length && want.every((m, i) => m === said[i]) && run.turns[want.length - 1]) return { run, index: want.length - 1 }
  }
  return null
}

export const MAX_MESSAGE = 600
/** Turns in one conversation: the first and up to three narrowing turns. */
export const MAX_TURNS = 4

export interface ScoutDeps {
  conversations: Conversations
  runs: RunCache
  recorded: () => Promise<RecordedRun[]>
  tools: Tool<QlooContext>[]
  /** Null when live scouting is impossible: no Qloo key, or no model. */
  live: null | { model: Model; ctx: QlooContext; budget: Budget; takeVisitorTurn(): Promise<boolean> }
  products?: { search(query: string, opts?: { limit?: number; maxPrice?: number }): Promise<SearchResult> }
  newId(): string
  ownerToken(id: string): Promise<string>
  now?: () => number
  /** Milliseconds between the events of a cached or recorded run, so it reads like the agent at work (0 in tests). */
  paceMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Sends saved events one by one, with the pause the moment deserves: a Qloo call, then a longer one before the cards. */
async function play(events: ScoutEvent[], pace: number, send: (e: ScoutEvent) => Promise<void>): Promise<void> {
  for (const [i, e] of events.entries()) {
    if (pace && i > 0) await sleep(e.t === 'cards' ? pace * 4 : e.t === 'call' || e.t === 'say' ? pace : pace / 2)
    await send(e)
  }
}

export function ndjsonResponse(): { response: Response; send(e: ScoutEvent): Promise<void>; close(): Promise<void> } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  return {
    response: new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }),
    send: (e) => writer.write(enc.encode(JSON.stringify(e) + '\n')),
    close: () => writer.close(),
  }
}

type Parsed = { ok: true; message: string; conversation?: string } | { ok: false; status: number; text: string }

export async function parseScout(request: Request): Promise<Parsed> {
  let body: { message?: unknown; conversation?: unknown }
  try { body = (await request.json()) as typeof body } catch { return { ok: false, status: 400, text: 'Send JSON with a message.' } }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (message.length < 3) return { ok: false, status: 400, text: 'Tell me a little about them first.' }
  if (message.length > MAX_MESSAGE) return { ok: false, status: 400, text: `Keep it under ${MAX_MESSAGE} characters.` }
  const conversation = typeof body.conversation === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(body.conversation) ? body.conversation : undefined
  return { ok: true, message, conversation }
}

/** Runs one turn and sends its events through `send`. The caller closes the stream. */
export async function scoutTurn(message: string, conversationId: string | undefined, deps: ScoutDeps, send: (e: ScoutEvent) => Promise<void>): Promise<void> {
  const saved = conversationId ? await deps.conversations.get(conversationId) : null
  if (conversationId && !saved) {
    await send({ t: 'error', text: 'That conversation has gone. Start a new one.' })
    return
  }
  const id = saved ? conversationId! : deps.newId()
  const isNew = !saved
  const state = saved?.state ?? newState(id)
  const turns = saved?.turns ?? []
  const turn = state.turn + 1
  const share = { t: 'done' as const, share: '/s/' + id }
  if (turn > MAX_TURNS) {
    await send({ t: 'error', text: 'That is as far as one conversation goes. Start a new one for more.' })
    return
  }

  // 1. The same first message, answered live before.
  // A run with product search has products on its cards: it is kept apart from one without, since both Workers share the cache.
  const key = turn === 1 ? (deps.products ? 'products:' : '') + await runKey(message) : ''
  if (turn === 1) {
    const earlier = await deps.runs.get(key)
    const old = earlier ? await deps.conversations.get(earlier) : null
    if (old && old.turns[0]) {
      const events = old.turns[0].map((e) => (e.t === 'run' ? { ...e, conversation: id, mode: 'cache' as const, said: message } : e))
      await send(events[0])
      if (isNew) await send({ t: 'owner', token: await deps.ownerToken(id) })
      await play(events.slice(1), deps.paceMs ?? 0, send)
      await deps.conversations.put(id, { ...old.state, id }, [events])
      await send(share)
      return
    }
  }

  // 2. Live.
  let why = ''
  if (!deps.live) why = 'Live scouting is off right now.'
  else if (!(await deps.live.budget.allow())) why = 'Live scouting has used its budget for today.'
  else if (!(await deps.live.takeVisitorTurn())) why = 'You have scouted a lot today.'
  if (!why && deps.live) {
    const events: ScoutEvent[] = [{ t: 'run', conversation: id, turn, mode: 'live', said: message }]
    await send(events[0])
    if (isNew) await send({ t: 'owner', token: await deps.ownerToken(id) })
    const next = await runTurn({
      message, state, model: deps.live.model, tools: deps.tools, ctx: deps.live.ctx, budget: deps.live.budget, now: deps.now,
      products: deps.products,
      emit: async (e) => { events.push(e); await send(e) },
    })
    await deps.conversations.put(id, next, [...turns, events])
    if (turn === 1 && next.cards.length >= 5 && new Set(next.cards.map((c) => c.entity.type)).size >= 3) {
      // A snapshot of the first turn alone, so a later visitor with the same message starts from exactly this turn.
      await deps.conversations.put('first-' + id, next, [events])
      await deps.runs.put(key, 'first-' + id)
    }
    await send(share)
    return
  }

  // 3. A recorded example (and its recorded narrowing turn).
  const found = findRecorded(await deps.recorded(), state.said, message)
  if (found) {
    const { run, index } = found
    const events = run.turns[index].map((e) => (e.t === 'run' ? { ...e, conversation: id, mode: 'replay' as const, recorded_at: run.recorded_at, said: message } : e))
    await send(events[0])
    if (isNew) await send({ t: 'owner', token: await deps.ownerToken(id) })
    await play(events.slice(1), deps.paceMs ?? 0, send)
    await deps.conversations.put(id, { ...structuredClone(run.states[index]), id }, [...turns, events])
    await send(share)
    return
  }
  await send({ t: 'run', conversation: id, turn, mode: 'off', said: message })
  await send({ t: 'error', text: why + ' The three examples still work.' })
}
