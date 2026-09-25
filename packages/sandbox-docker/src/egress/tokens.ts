// Tokens an agent derives from its brokered key: the gateway replaces them in the exchange's
// response with placeholders, and swaps the real ones back in on the agent's own hosts.
import { randomInt } from 'node:crypto'
import type { EndpointMatch } from './rules.ts'
import type { Substitution } from './substitution.ts'

export type DerivedTokens = {
  /** The credential the tokens come from, for logs; never a value. */
  name: string
  /** The exchange request whose JSON response carries the tokens. */
  endpoint: EndpointMatch
  /** Top-level string fields of that response that hold tokens. */
  fields: readonly string[]
  /** Where the agent sends the tokens: the placeholders are swapped back only there, in headers. */
  hosts: readonly string[]
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const random = (n: number) => Array.from({ length: n }, () => BASE62[randomInt(62)]).join('')

const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/

/**
 * A placeholder for a token. A JWT keeps its header and claims, so a client reading its `exp` sees
 * the real one, and gets `es_secret_…` for a signature; anything else is a plain `es_secret_…`.
 */
export function tokenPlaceholder(token: string): string {
  if (!JWT.test(token)) return `es_secret_${random(32)}`
  const [header, claims] = token.split('.')
  return `${header}.${claims}.es_secret_${random(43)}`
}

/**
 * The exchange response with each token field replaced by a placeholder, and a substitution per
 * token. A token already seen keeps its placeholder. Throws when the body isn't a JSON object.
 */
export function tokeniseResponse(
  derived: DerivedTokens,
  body: string,
  known: readonly Substitution[],
): { body: string; added: Substitution[]; fields: string[] } {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the response is not a JSON object')
  }
  const out = { ...(parsed as Record<string, unknown>) }
  const added: Substitution[] = []
  const fields: string[] = []
  for (const field of derived.fields) {
    const value = out[field]
    if (typeof value !== 'string' || value === '') continue
    const existing = [...known, ...added].find((s) => s.value === value)
    const sub = existing ?? {
      name: `${derived.name} ${field}`,
      placeholder: tokenPlaceholder(value),
      value,
      hosts: derived.hosts,
      in: ['header'] as const,
      scrubBodies: false,
    }
    if (!existing) added.push(sub)
    out[field] = sub.placeholder
    fields.push(field)
  }
  return { body: JSON.stringify(out), added, fields }
}
