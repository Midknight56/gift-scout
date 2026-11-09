// The language model behind the agent: Workers AI, chat with tools in the usual chat completion shape. Every call is priced in
// neurons from its own token counts, so the daily budget counts what was really spent.

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name: string }

export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: unknown } }

export interface ModelReply {
  content: string
  tool_calls: ToolCall[]
  prompt_tokens: number
  completion_tokens: number
  cut?: boolean
  /** Workers AI's own count, when it gives one (it did on 23 Oct 2026, and it matched the price list). */
  neurons?: number
}

export interface ModelChatOptions {
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface Model {
  readonly name: string
  chat(messages: ChatMessage[], tools: ToolSpec[], maxTokens: number, options?: ModelChatOptions): Promise<ModelReply>
}

// Prices read 6 Nov 2026 from developers.cloudflare.com/workers-ai/platform/pricing: @cf/openai/gpt-oss-20b costs
// $0.200 per million input tokens and $0.300 per million output tokens, or 18,182 and 27,273 neurons. The old model's
// page says it is planned to go away on 20 Nov 2026. The daily caps in src/limits.ts are unchanged (2,000 a day, 3,500
// in judging windows, 9,500 for the whole account), under the free 10,000 neurons a day, so usage costs $0.
export const MODEL = '@cf/openai/gpt-oss-20b'
export const NEURONS_PER_INPUT_TOKEN = 18182 / 1e6
export const NEURONS_PER_OUTPUT_TOKEN = 27273 / 1e6

export function neuronsFor(promptTokens: number, completionTokens: number): number {
  return promptTokens * NEURONS_PER_INPUT_TOKEN + completionTokens * NEURONS_PER_OUTPUT_TOKEN
}

// The most input tokens a call can hold, from its size. Every token of this model's tokenizer stands for at least one
// byte of text, so the UTF-8 bytes of the messages are never fewer than their tokens. Tools are rendered into the
// prompt in another form than JSON, so their bytes count one and a half times. Each message adds a few format tokens
// and the prompt adds a fixed header: 16 a message and 400 in all cover both with room.
export function inputTokenBound(messages: ChatMessage[], tools: ToolSpec[]): number {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  return size(messages) + Math.ceil(size(tools) * 1.5) + 16 * messages.length + 400
}

/** The most one call can cost: its input bound plus every output token it is allowed, in whole neurons. */
export function callReserve(messages: ChatMessage[], tools: ToolSpec[], maxTokens: number): number {
  return Math.ceil(neuronsFor(inputTokenBound(messages, tools), maxTokens))
}

/** What Workers AI answers: the chat completion shape for this model, or the older flat shape. */
interface RawReply {
  choices?: { finish_reason?: string | null; message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning?: string | null; reasoning_content?: string | null } }[]
  response?: string | null
  tool_calls?: { name?: string; arguments?: unknown; id?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; neurons?: number }
}

/** A call written as bare JSON in the content, without tags. Measured 25 Oct 2026: present_gifts came back this way,
 *  one closing brace short, so up to two are added before giving up. Only a tool offered in that request counts. */
function bareTextToolCall(text: string, offered?: string[]): { call: ToolCall; content: string } | undefined {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const close = cleaned.lastIndexOf('}')
  if (start < 0) return undefined
  const end = close >= start ? close + 1 : cleaned.length
  const json = cleaned.slice(start, end)
  for (let extra = 0; extra <= 2; extra++) {
    try {
      const value = JSON.parse(json + '}'.repeat(extra)) as { name?: unknown; arguments?: unknown }
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string') continue
      if (typeof value.arguments !== 'string' && (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments))) continue
      if (offered && !offered.includes(value.name)) return undefined
      const args = typeof value.arguments === 'string' ? value.arguments : JSON.stringify(value.arguments)
      return {
        call: { id: 'text_0', type: 'function', function: { name: value.name, arguments: args } },
        content: (cleaned.slice(0, start) + cleaned.slice(end)).trim(),
      }
    } catch { /* a cut off or broken call is skipped */ }
  }
  return undefined
}

/** A present_gifts argument object some models return without the outer tool call wrapper. */
function barePresentGifts(text: string, offered?: string[]): { call: ToolCall; content: string } | undefined {
  if (!offered?.includes('present_gifts')) return undefined
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const close = cleaned.lastIndexOf('}')
  if (start < 0) return undefined
  const end = close >= start ? close + 1 : cleaned.length
  const json = cleaned.slice(start, end)
  for (let extra = 0; extra <= 2; extra++) {
    try {
      const value = JSON.parse(json + '}'.repeat(extra)) as Record<string, unknown>
      if (!value || typeof value !== 'object' || Array.isArray(value) || 'name' in value || (!('ideas' in value) && !('cards' in value))) continue
      return {
        call: { id: 'text_0', type: 'function', function: { name: 'present_gifts', arguments: json + '}'.repeat(extra) } },
        content: (cleaned.slice(0, start) + cleaned.slice(end)).trim(),
      }
    } catch { /* a cut off or broken argument object is skipped */ }
  }
  return undefined
}

/** Calls the model wrote as text, `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`. Some models place these
 *  calls inside `reasoning` while leaving `tool_calls` empty. */
export function textToolCalls(text: string, offered?: string[]): ToolCall[] {
  const out: ToolCall[] = []
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    try {
      const c = JSON.parse(m[1]) as { name?: unknown; arguments?: unknown }
      if (typeof c.name !== 'string') continue
      const args = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {})
      out.push({ id: 'text_' + out.length, type: 'function', function: { name: c.name, arguments: args } })
    } catch { /* a cut off or broken call is skipped */ }
  }
  if (out.length) return out
  const bare = bareTextToolCall(text, offered)
  return bare ? [bare.call] : []
}

/** Reads either answer shape into one. Exported for the tests. */
export function readReply(raw: RawReply, offered?: string[], maxTokens?: number): ModelReply {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid model reply')
  if (raw.choices !== undefined && (!Array.isArray(raw.choices) || !raw.choices[0]?.message || typeof raw.choices[0].message !== 'object')) throw new Error('Invalid model reply')
  if (raw.tool_calls !== undefined && !Array.isArray(raw.tool_calls)) throw new Error('Invalid model reply')
  if (raw.response !== undefined && raw.response !== null && typeof raw.response !== 'string') throw new Error('Invalid model reply')
  const rawMessage = raw.choices?.[0]?.message
  if (rawMessage?.content !== undefined && rawMessage.content !== null && typeof rawMessage.content !== 'string') throw new Error('Invalid model reply')
  if (rawMessage?.tool_calls !== undefined && !Array.isArray(rawMessage.tool_calls)) throw new Error('Invalid model reply')
  if (rawMessage?.tool_calls?.some((c) => !c || typeof c.function?.name !== 'string' || typeof c.function.arguments !== 'string')) throw new Error('Invalid model reply')
  const hasReply = Boolean(rawMessage && (typeof rawMessage.content === 'string' || rawMessage.content === null || Array.isArray(rawMessage.tool_calls))) || typeof raw.response === 'string' || Boolean(raw.tool_calls?.length)
  if (!hasReply) throw new Error('Invalid model reply')
  const msg = raw.choices?.[0]?.message
  let calls: ToolCall[] = msg?.tool_calls ?? []
  if (!calls.length && raw.tool_calls?.length) {
    if (raw.tool_calls.some((c) => !c || typeof c.name !== 'string' || (c.arguments !== undefined && typeof c.arguments !== 'string' && typeof c.arguments !== 'object'))) throw new Error('Invalid model reply')
    calls = raw.tool_calls.map((c, i) => ({
      id: c.id ?? 'call_' + i,
      type: 'function',
      function: { name: c.name ?? '', arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
    }))
  }
  if (calls.some((c) => !c || typeof c.function?.name !== 'string' || typeof c.function.arguments !== 'string')) throw new Error('Invalid model reply')
  let content = msg?.content ?? raw.response ?? ''
  if (!calls.length) {
    const bare = bareTextToolCall(content, offered)
    calls = textToolCalls(content, offered)
    if (bare && calls.length) content = bare.content
    if (!calls.length) {
      const present = barePresentGifts(content, offered)
      if (present) { calls = [present.call]; content = present.content }
    }
    const reasoning = msg?.reasoning ?? msg?.reasoning_content ?? ''
    if (!calls.length) {
      const present = barePresentGifts(reasoning, offered)
      if (present) calls = [present.call]
      else calls = textToolCalls(reasoning, offered)
    }
    if (!calls.length && !content.trim()) content = reasoning
  }
  if (calls.length) content = content.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '')
  const reply: ModelReply = {
    content: stripThinking(content),
    tool_calls: calls,
    prompt_tokens: raw.usage?.prompt_tokens ?? 0,
    completion_tokens: raw.usage?.completion_tokens ?? 0,
    cut: raw.choices?.[0]?.finish_reason === 'length' || (maxTokens !== undefined && (raw.usage?.completion_tokens ?? 0) >= maxTokens),
  }
  if (typeof raw.usage?.neurons === 'number') reply.neurons = raw.usage.neurons
  return reply
}

/** Some models wrap their reasoning in <think> tags inside the content; the person never sees it. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim()
}

/** The part of the Workers AI binding used here, so the tests need no Workers types. */
export interface AiBinding { run(model: string, input: unknown): Promise<unknown> }

export class WorkersAiModel implements Model {
  readonly name = MODEL
  constructor(private ai: AiBinding, private timeoutMs = 45_000) {}

  async chat(messages: ChatMessage[], tools: ToolSpec[], maxTokens: number, options?: ModelChatOptions): Promise<ModelReply> {
    const input = {
      messages,
      ...(tools.length ? { tools } : {}),
      max_tokens: maxTokens,
      temperature: 0.3,
      ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let raw: unknown
    try {
      raw = await Promise.race([
        this.ai.run(MODEL, input),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('The model took too long.')), this.timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    return readReply(raw as RawReply, tools.map((tool) => tool.function.name), maxTokens)
  }
}
