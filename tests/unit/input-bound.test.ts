import { describe, expect, it } from 'vitest'
import { newState, runTurn, type Budget } from '../../src/agent/agent'
import { runCompare } from '../../src/agent/compare'
import type { ScoutEvent } from '../../src/agent/events'
import { callReserve, inputTokenBound, neuronsFor, type ChatMessage, type Model, type ToolSpec } from '../../src/agent/model'
import { MAX_CALL_NEURONS } from '../../src/limits'
import { NeuronLedger } from '../../src/store/d1'
import { QlooClient, type Cache } from '../../src/qloo/client'
import { qlooTools } from '../../src/qloo/tools'
import { FakeD1 } from './fake-d1'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

/** A model that keeps what each call was sent and then fails, so no tool or card logic runs. */
function recording(): Model & { sent: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number }[] } {
  const sent: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens: number }[] = []
  return { name: 'recording', sent, async chat(messages, tools, maxTokens) { sent.push({ messages: structuredClone(messages), tools, maxTokens }); throw new Error('stop') } }
}

function sizedBudget(): Budget & { asked: (number | undefined)[] } {
  const asked: (number | undefined)[] = []
  return { asked, allow: async () => true, reserve: async (neurons?: number) => { asked.push(neurons); return { settle: async () => {} } } }
}

function qlooCtx() {
  const cache: Cache = { get: async () => null, put: async () => {} }
  const fetcher = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  return { qloo: new QlooClient('k', fetcher, cache, async () => true) }
}

describe('the input size bound and the neuron reserve', () => {
  it('never counts fewer tokens than the UTF-8 bytes of the messages and tools', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Café crème for my aunt' }]
    const tools: ToolSpec[] = [{ type: 'function', function: { name: 'x', description: 'Does x.', parameters: { type: 'object' } } }]
    expect(inputTokenBound(messages, tools)).toBeGreaterThan(bytes(messages) + bytes(tools))
    // "é" is two bytes in UTF-8, so two accented letters add at least two more than plain ones.
    const plain: ChatMessage[] = [messages[0], { role: 'user', content: 'Cafe creme for my aunt' }]
    expect(inputTokenBound(messages, tools) - inputTokenBound(plain, tools)).toBeGreaterThanOrEqual(2)
  })

  it('reserves the most the call can cost: the input bound plus every allowed output token', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]
    const want = Math.ceil(neuronsFor(inputTokenBound(messages, []), 1400))
    expect(callReserve(messages, [], 1400)).toBe(want)
  })

  it('the ledger holds the amount it is asked to hold', async () => {
    const db = new FakeD1()
    const ledger = new NeuronLedger(db as never, { app: 'gift-scout', dailyCap: 1000, accountCap: 2000, reserve: 1, day: () => '2026-11-09' })
    expect(await ledger.reserve(300)).not.toBeNull()
    expect((await ledger.spentToday()).app).toBe(300)
    expect(await ledger.reserve(701)).toBeNull()
  })

  it('a scout turn reserves what its own first call can cost', async () => {
    const model = recording()
    const budget = sizedBudget()
    await runTurn({ message: 'My sister loves Phoebe Bridgers.', state: newState('c1'), model, tools: qlooTools(), ctx: qlooCtx(), budget, emit: () => {} })
    expect(model.sent).toHaveLength(1)
    const first = model.sent[0]
    expect(budget.asked[0]).toBe(callReserve(first.messages, first.tools, first.maxTokens))
  })

  it('an input too large for one call is refused before any reserve or model call', async () => {
    const model = recording()
    const budget = sizedBudget()
    const events: ScoutEvent[] = []
    await runTurn({ message: 'gift '.repeat(20000), state: newState('c1'), model, tools: qlooTools(), ctx: qlooCtx(), budget, emit: (e) => { events.push(e) } })
    expect(model.sent).toHaveLength(0)
    expect(budget.asked).toHaveLength(0)
    expect(events.some((e) => e.t === 'error' && /too long/i.test(e.text))).toBe(true)
  })

  it('the comparison reserves what its call can cost', async () => {
    const model = recording()
    const budget = sizedBudget()
    await runCompare({ message: 'compare these', turns: [], cards: [], qloo: {} as never, model, budget, emit: async () => {} })
    const first = model.sent[0]
    expect(budget.asked[0]).toBe(callReserve(first.messages, first.tools, first.maxTokens))
    expect(budget.asked[0]).toBeLessThanOrEqual(MAX_CALL_NEURONS)
  })
})
