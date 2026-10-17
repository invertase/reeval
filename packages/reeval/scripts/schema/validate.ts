// Checks a value against a generated shape schema (the subset `generate.ts` writes). Unknown
// properties are allowed: an older reeval ignores fields a newer one added.
import { resolve, type Schema, type ShapeSchema } from './generate.ts'

/** Where `value` doesn't fit `doc`, as `path: problem` lines; empty when it fits. */
export function validate(doc: ShapeSchema, value: unknown): string[] {
  const problems: string[] = []
  check(doc, { $ref: doc.$ref }, value, '', problems)
  return problems
}

/** Whether `value` fits `schema`, a part of `doc`. */
export function fits(doc: ShapeSchema, schema: Schema, value: unknown): boolean {
  const problems: string[] = []
  check(doc, schema, value, '', problems)
  return problems.length === 0
}

function check(doc: ShapeSchema, schema: Schema, value: unknown, path: string, out: string[]) {
  const s = resolve(doc, schema)
  const at = path || '(root)'
  // Zod writes a discriminated union as `oneOf`; its variants never overlap, so it reads as `anyOf`.
  const alternatives = s.anyOf ?? s.oneOf
  if (alternatives) {
    if (alternatives.some((a) => fits(doc, a, value))) return
    // Report against the variant it was most likely meant to be, by its const fields.
    const objects = alternatives
      .map((a) => resolve(doc, a))
      .filter((a) => a.type === 'object' && value && typeof value === 'object')
    const match = objects.find((o) =>
      Object.entries(o.properties ?? {}).some(([k, p]) => {
        const r = resolve(doc, p)
        return 'const' in r && (value as Record<string, unknown>)[k] === r.const
      }),
    )
    if (match) check(doc, match, value, path, out)
    else
      out.push(
        `${at}: ${JSON.stringify(value)?.slice(0, 80)} fits none of ${alternatives.length} alternatives`,
      )
    return
  }
  if ('const' in s) {
    if (value !== s.const)
      out.push(`${at}: expected ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}`)
    return
  }
  if (s.enum) {
    if (!s.enum.includes(value as string))
      out.push(`${at}: ${JSON.stringify(value)} isn't one of ${s.enum.join(', ')}`)
    return
  }
  switch (s.type) {
    case undefined:
      return
    case 'null':
      if (value !== null) out.push(`${at}: expected null, got ${typeof value}`)
      return
    case 'array':
      if (!Array.isArray(value))
        out.push(`${at}: expected an array, got ${value === undefined ? 'nothing' : typeof value}`)
      else for (const [i, v] of value.entries()) check(doc, s.items ?? {}, v, `${path}[${i}]`, out)
      return
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        out.push(
          `${at}: expected an object, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`,
        )
        return
      }
      const obj = value as Record<string, unknown>
      for (const key of s.required ?? []) {
        if (obj[key] === undefined) out.push(`${path ? `${path}.` : ''}${key}: missing`)
      }
      for (const [key, v] of Object.entries(obj)) {
        const p = s.properties?.[key] ?? s.additionalProperties
        if (p && v !== undefined) check(doc, p, v, path ? `${path}.${key}` : key, out)
      }
      return
    }
    case 'integer':
      if (!Number.isInteger(value))
        out.push(`${at}: expected a whole number, got ${JSON.stringify(value) ?? 'nothing'}`)
      return
    default:
      if (typeof value !== s.type)
        out.push(`${at}: expected ${s.type}, got ${value === undefined ? 'nothing' : typeof value}`)
  }
}

/**
 * Adds `extra` as a new field to every fixed-shape object in `value`, as a newer reeval that added
 * fields would write it. Records (`Record<string, …>`) are left alone: a new key there is data.
 */
export function withUnknownFields(doc: ShapeSchema, value: unknown, extra: () => unknown): void {
  const walk = (schema: Schema, v: unknown) => {
    const s = resolve(doc, schema)
    const alternatives = s.anyOf ?? s.oneOf
    if (alternatives) {
      const match = alternatives.find((a) => fits(doc, a, v))
      if (match) walk(match, v)
      return
    }
    if (s.type === 'array' && Array.isArray(v)) for (const item of v) walk(s.items ?? {}, item)
    if (s.type !== 'object' || !v || typeof v !== 'object') return
    const obj = v as Record<string, unknown>
    for (const [key, child] of Object.entries(obj)) {
      const p = s.properties?.[key] ?? s.additionalProperties
      if (p) walk(p, child)
    }
    if (!s.additionalProperties) obj.addedLater = extra()
  }
  walk({ $ref: doc.$ref }, value)
}
