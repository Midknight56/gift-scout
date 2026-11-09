import { describe, expect, it } from 'vitest'
import { deprecationIn } from '../../tools/model_check.mjs'
import { MAX_OUTPUT_TOKENS } from '../../src/agent/agent'
import { MODEL, neuronsFor, WorkersAiModel, type AiBinding } from '../../src/agent/model'
import { MAX_CALL_NEURONS } from '../../src/limits'

describe('Workers AI model check', () => {
  it('finds planned deprecation notices in the model page', () => {
    expect(deprecationIn('<td>Planned Deprecation</td><td>11/20/2026</td>')).toBe('Planned Deprecation')
    expect(deprecationIn('Planned deprecation')).toBe('Planned deprecation')
    expect(deprecationIn('Function calling Yes')).toBeNull()
  })

  it('uses the replacement model and its token prices', () => {
    expect(MODEL).toBe('@cf/openai/gpt-oss-20b')
    expect(neuronsFor(1_000_000, 0)).toBeCloseTo(18182)
    expect(neuronsFor(0, 1_000_000)).toBeCloseTo(27273)
  })

  it('reserves enough for one capped model call', () => {
    expect(MAX_CALL_NEURONS).toBeGreaterThanOrEqual(neuronsFor(5300, MAX_OUTPUT_TOKENS))
  })

  it('puts reasoning_effort in the input when asked and leaves it out when not', async () => {
    const inputs: unknown[] = []
    const ai: AiBinding = {
      run: async (_model, input) => {
        inputs.push(input)
        return { response: 'ok' }
      },
    }
    const model = new WorkersAiModel(ai)
    await model.chat([{ role: 'user', content: 'hello' }], [], 100, { reasoningEffort: 'low' })
    await model.chat([{ role: 'user', content: 'hello' }], [], 100)
    expect(inputs[0]).toMatchObject({ reasoning_effort: 'low', max_tokens: 100 })
    expect(Object.hasOwn(inputs[1] as object, 'reasoning_effort')).toBe(false)
  })
})
