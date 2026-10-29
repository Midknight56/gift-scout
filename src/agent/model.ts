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

export interface Model {
  readonly name: string
  chat(messages: ChatMessage[], tools: ToolSpec[], maxTokens: number): Promise<ModelReply>
}

// Prices read 22 Oct 2026 from developers.cloudflare.com/workers-ai/platform/pricing: @cf/qwen/qwen3-30b-a3b-fp8 costs
// 4,625 neurons per million input tokens and 30,475 per million output tokens. Its page lists function calling: yes,
// context window 32,768 tokens.
export const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8'
export const NEURONS_PER_INPUT_TOKEN = 4625 / 1e6
export const NEURONS_PER_OUTPUT_TOKEN = 30475 / 1e6

export function neuronsFor(promptTokens: number, completionTokens: number): number {
  return promptTokens * NEURONS_PER_INPUT_TOKEN + completionTokens * NEURONS_PER_OUTPUT_TOKEN
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

/** Calls the model wrote as text, `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`. Measured 23 Oct 2026: with
 *  thinking off, Workers AI returned qwen3's tool calls this way inside `reasoning`, and `tool_calls` was empty. */
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
    const reasoning = msg?.reasoning ?? msg?.reasoning_content ?? ''
    if (!calls.length) calls = textToolCalls(reasoning, offered)
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

/** Qwen3 may wrap its reasoning in <think> tags inside the content; the person never sees it. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim()
}

/** The part of the Workers AI binding used here, so the tests need no Workers types. */
export interface AiBinding { run(model: string, input: unknown): Promise<unknown> }

export class WorkersAiModel implements Model {
  readonly name = MODEL
  constructor(private ai: AiBinding, private timeoutMs = 45_000) {}

  async chat(messages: ChatMessage[], tools: ToolSpec[], maxTokens: number): Promise<ModelReply> {
    // Thinking is off. Measured 23 Oct 2026 on the same first message: with it on, 4 model calls took 129 neurons and
    // 22 s; with it off, one call took 10.5 neurons and about 2 s.
    const input = { messages, ...(tools.length ? { tools } : {}), max_tokens: maxTokens, temperature: 0.3, chat_template_kwargs: { enable_thinking: false } }
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
