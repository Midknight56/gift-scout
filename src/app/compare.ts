import type { Budget } from '../agent/agent'
import { firstTurnSeedIds, runCompare } from '../agent/compare'
import type { ScoutEvent } from '../agent/events'
import type { Model } from '../agent/model'
import type { QlooClient } from '../qloo/client'
import type { Conversations } from '../store/d1'

export interface CompareDeps {
  conversations: Conversations
  live: null | { model: Model; qloo: QlooClient; budget: Budget; takeVisitorCompare(): Promise<boolean> }
}

// Compare turns in flight in this isolate; this does not coordinate across isolates.
const compareLocks = new Map<string, Promise<void>>()

async function withCompareLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = compareLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  compareLocks.set(key, current)
  await previous
  try { return await action() } finally {
    release()
    if (compareLocks.get(key) === current) compareLocks.delete(key)
  }
}

export async function parseCompare(request: Request): Promise<{ conversation: string; owner?: string } | null> {
  let body: { conversation?: unknown; owner?: unknown }
  try { body = await request.json() as typeof body } catch { return null }
  if (typeof body.conversation !== 'string' || !/^[A-Za-z0-9_-]{6,48}$/.test(body.conversation)) return null
  return { conversation: body.conversation, owner: typeof body.owner === 'string' ? body.owner : undefined }
}

/** Streams a Qloo comparison and saves its events to the conversation for share links. */
export async function compareTurn(conversationId: string, deps: CompareDeps, send: (event: ScoutEvent) => Promise<void>): Promise<void> {
  return withCompareLock(conversationId, async () => {
    const saved = await deps.conversations.get(conversationId)
    if (!saved) {
      await send({ t: 'error', text: 'That conversation has gone. Start a new one.' })
      await send({ t: 'done', share: '/s/' + conversationId })
      return
    }
    // Only a finished comparison counts: a turn that ended in an error (no AI, the cap) can be tried again.
    if (saved.turns.flat().some((event) => event.t === 'compare')) {
      await send({ t: 'error', text: 'This conversation was already compared.' })
      await send({ t: 'done', share: '/s/' + conversationId })
      return
    }
    const state = saved.state
    const firstCards = saved.turns[0]?.find((event) => event.t === 'cards')
    if (!firstCards || firstCards.t !== 'cards' || !firstCards.cards.length) {
      await send({ t: 'error', text: 'This conversation needs gift ideas before it can be compared.' })
      await send({ t: 'done', share: '/s/' + conversationId })
      return
    }
    const events: ScoutEvent[] = []
    const sendSaved = async (event: ScoutEvent) => { events.push(event); await send(event) }
    const run: ScoutEvent = { t: 'run', conversation: conversationId, turn: state.turn, mode: deps.live ? 'live' : 'off', purpose: 'compare', said: state.said[0] }
    await sendSaved(run)
    if (!deps.live) {
      await sendSaved({ t: 'error', text: 'Comparing needs the live taste graph, which is not available right now.' })
    } else if (!(await deps.live.takeVisitorCompare())) {
      await sendSaved({ t: 'error', text: 'You have compared a lot today.' })
    } else {
      await runCompare({
        message: state.said[0] ?? '', seedIds: firstTurnSeedIds(saved.turns), cards: firstCards.cards,
        qloo: deps.live.qloo, model: deps.live.model, budget: deps.live.budget, callStart: state.calls,
        emit: sendSaved,
      })
      state.calls += events.filter((event) => event.t === 'call').length
    }
    await deps.conversations.put(conversationId, state, [...saved.turns, events])
    await send({ t: 'done', share: '/s/' + conversationId })
  })
}
