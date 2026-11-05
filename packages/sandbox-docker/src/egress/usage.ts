/**
 * The usage fields of the model APIs the agents call: Anthropic's Messages, OpenAI's Responses
 * and Chat Completions (and the APIs shaped like them), and Gemini's `usageMetadata`. A nested
 * details object (`input_tokens_details`, `output_tokens_details`) gives its fields by their own
 * names.
 */
const FIELDS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'prompt_tokens',
  'completion_tokens',
  'cached_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'thinking_tokens',
  'promptTokenCount',
  'candidatesTokenCount',
  'cachedContentTokenCount',
  'thoughtsTokenCount',
])

/** xAI's `context_details` repeats `input_tokens` and `output_tokens` as the context counts them. */
const SKIP = new Set(['context_details'])

/** The model a model call's response names: Gemini's `generateContent` says `modelVersion`. */
export const MODEL_FIELD = /"model(?:Id|Version)?"\s*:\s*"([^"\\]{1,200})"/

const USAGE_KEY = /"(?:usage|usageMetadata)"\s*:\s*\{/g

/** How much of a chunk's end is kept while no usage object is open, so a split key is seen. */
const CARRY = 64

/** The longest usage object read; a longer one is dropped. */
const OBJECT_LIMIT = 64 * 1024

function flatten(value: unknown, out: Record<string, number>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const [key, v] of Object.entries(value)) {
    if (SKIP.has(key)) continue
    if (typeof v === 'number' && Number.isFinite(v) && FIELDS.has(key)) out[key] = v
    else flatten(v, out)
  }
}

/**
 * Reads a response body's usage objects as it flows, whole: each `"usage"` or `"usageMetadata"`
 * object is parsed and its fields merged over the earlier ones', since a stream's later events
 * repeat its counts or replace them with the final ones (Anthropic's `message_delta`, Gemini's
 * last chunk, the Responses API's `response.completed`). Inside a JSON string the quotes are
 * escaped, so text that merely mentions a usage object doesn't match. Each call returns the
 * fields so far when that chunk completed an object, and null otherwise.
 */
export function usageReader(): (chunk: string) => Record<string, number> | null {
  const fields: Record<string, number> = {}
  let pending = ''
  let object: string | null = null
  let depth = 0
  let inString = false
  let escaped = false
  return (chunk) => {
    let found = false
    let text = object === null ? pending + chunk : chunk
    let from = 0
    for (;;) {
      if (object === null) {
        USAGE_KEY.lastIndex = from
        const key = USAGE_KEY.exec(text)
        if (!key) {
          pending = text.slice(Math.max(from, text.length - CARRY))
          break
        }
        object = '{'
        depth = 1
        inString = false
        escaped = false
        from = key.index + key[0].length
      }
      let end = -1
      for (let i = from; i < text.length; i++) {
        const c = text[i]
        if (inString) {
          if (escaped) escaped = false
          else if (c === '\\') escaped = true
          else if (c === '"') inString = false
        } else if (c === '"') inString = true
        else if (c === '{') depth++
        else if (c === '}' && --depth === 0) {
          end = i
          break
        }
      }
      if (end === -1) {
        object += text.slice(from)
        if (object.length > OBJECT_LIMIT) object = null
        pending = ''
        break
      }
      const json = object + text.slice(from, end + 1)
      object = null
      try {
        const got: Record<string, number> = {}
        flatten(JSON.parse(json), got)
        if (Object.keys(got).length > 0) {
          Object.assign(fields, got)
          found = true
        }
      } catch {}
      text = text.slice(end + 1)
      from = 0
    }
    return found ? { ...fields } : null
  }
}
