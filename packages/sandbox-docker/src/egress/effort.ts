// The reasoning settings a model call's request body carries, read where the API puts them:
// Gemini's `thinkingConfig`, OpenAI's and the gateways' effort fields, and Anthropic's thinking.

/** The paths read, in order; `*` is any key of an object (a gateway's provider name). */
const PATHS = [
  'generationConfig.thinkingConfig.thinkingLevel',
  'generationConfig.thinkingConfig.thinkingBudget',
  'providerOptions.*.thinkingConfig.thinkingLevel',
  'providerOptions.*.thinkingConfig.thinkingBudget',
  'providerOptions.*.reasoningEffort',
  'reasoning_effort',
  'reasoning.effort',
  'reasoning.max_tokens',
  'reasoning.enabled',
  'output_config.effort',
  'thinking.type',
  'thinking.budget_tokens',
] as const

type Found = { path: string; value: string }

function walk(value: unknown, keys: readonly string[], at: string[], out: Found[]): void {
  if (keys.length === 0) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      out.push({ path: at.join('.'), value: String(value) })
    }
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const [key, ...rest] = keys as [string, ...string[]]
  const record = value as Record<string, unknown>
  for (const name of key === '*' ? Object.keys(record).sort() : [key]) {
    if (Object.hasOwn(record, name)) walk(record[name], rest, [...at, name], out)
  }
}

/**
 * Every reasoning setting in a JSON request body, as `<path>=<value>` joined by spaces
 * (`reasoning_effort=high`, `providerOptions.google.thinkingConfig.thinkingLevel=low`), or
 * undefined when it carries none or isn't JSON.
 */
export function requestedEffort(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const found: Found[] = []
  for (const path of PATHS) walk(parsed, path.split('.'), [], found)
  return found.length ? found.map((f) => `${f.path}=${f.value}`).join(' ') : undefined
}
