// What a harness reports about a turn beyond its stream: the events it couldn't, and its cost.
import type { WebEventType } from '../types.ts'

const WEB_EVENTS: Record<string, WebEventType> = { webSearch: 'web-search', webFetch: 'web-fetch' }

/** `harnessMetadata.cursorSdk.unreportedTools` as transcript event types. */
export function cursorUnreported(harnessMetadata: unknown): WebEventType[] {
  const meta = harnessMetadata as { cursorSdk?: { unreportedTools?: unknown } } | undefined
  const tools = meta?.cursorSdk?.unreportedTools
  return Array.isArray(tools) ? tools.flatMap((t) => (WEB_EVENTS[t] ? [WEB_EVENTS[t]] : [])) : []
}

const usdIn = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

/** Claude Code's `total_cost_usd`, its session's cost so far, as its bridge reports it. */
export function claudeCodeCost(harnessMetadata: unknown) {
  const meta = (
    harnessMetadata as { 'claude-code'?: { costUsd?: unknown; sessionId?: unknown } }
  )?.['claude-code']
  const usd = usdIn(meta?.costUsd)
  if (usd === undefined) return undefined
  return { usd, session: typeof meta?.sessionId === 'string' ? meta.sessionId : '' }
}

/** The sum of the turn's model calls' `cost.total`, priced by pi or billed by OpenRouter. */
export function piCost(harnessMetadata: unknown) {
  const usd = usdIn((harnessMetadata as { pi?: { costUsd?: unknown } })?.pi?.costUsd)
  return usd === undefined ? undefined : { usd }
}
