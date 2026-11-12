/**
 * Classifies an unhandled mid-turn error as `config` or `transport`.
 *
 * `config`: the harness refused the request before any model output (HTTP 400,
 * 401, 403, 404, or 422, or an adapter refusal of a model or option).
 * Everything else is `transport` (5xx, network, stream reset, `[unavailable]`).
 */
export type TurnErrorKind = 'transport' | 'config'

const CONFIG_STATUS = /\b(400|401|403|404|422)\b/
const CONFIG_WORDS =
  /\b(invalid[_ ]?(request|argument|model|option)|unauthorized|forbidden|not[_ ]found|unprocessable|model[_ ]not[_ ]found|unknown[_ ]model|unsupported[_ ](model|option)|refused)\b/i
const TRANSPORT_MARKERS =
  /\b(502|503|504|500|429|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket|network|unavailable|stream reset|fetch failed)\b/i

export function turnErrorKind(error: string | null | undefined): TurnErrorKind {
  if (!error) return 'transport'
  const text = error.trim()
  if (!text) return 'transport'
  if (CONFIG_STATUS.test(text) || CONFIG_WORDS.test(text)) return 'config'
  if (TRANSPORT_MARKERS.test(text) || /\[unavailable\]/i.test(text)) return 'transport'
  // A refusal-shaped message without a status still counts as config.
  if (/\brefus(e|al|ed)\b/i.test(text) && !TRANSPORT_MARKERS.test(text)) return 'config'
  return 'transport'
}
