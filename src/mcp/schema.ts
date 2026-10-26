// The subset of JSON Schema used to validate tool arguments.

export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  enum?: readonly (string | number)[]
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  maximum?: number
  items?: JsonSchema
  maxItems?: number
}

export function validate(schema: JsonSchema, value: unknown, path = 'arguments'): string[] {
  const out: string[] = []
  const t = schema.type
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object`]
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (obj[key] === undefined) out.push(`${path}.${key} is required`)
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key]
      if (!sub) { if (schema.additionalProperties === false) out.push(`${path}.${key} is not expected`); continue }
      if (v !== undefined) out.push(...validate(sub, v, `${path}.${key}`))
    }
    return out
  }
  if (t === 'string') {
    if (typeof value !== 'string') return [`${path} must be text`]
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) out.push(`${path} is too short`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path} is longer than ${schema.maxLength} characters`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(`${path} is not in the expected form`)
  } else if (t === 'integer' || t === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (t === 'integer' && !Number.isInteger(value))) return [`${path} must be a ${t}`]
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path} must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path} must be at most ${schema.maximum}`)
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') return [`${path} must be true or false`]
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${path} must be a list`]
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path} has more than ${schema.maxItems} items`)
    if (schema.items) value.forEach((v, i) => out.push(...validate(schema.items!, v, `${path}[${i}]`)))
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) out.push(`${path} must be one of ${schema.enum.join(', ')}`)
  return out
}
