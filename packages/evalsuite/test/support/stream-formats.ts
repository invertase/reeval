// The shape of each agent CLI's native stream, as signatures: which events and step types it
// sends, the key paths in each, the states it reports and the tools it advertises. Taken from the
// `raw` parts of a raw transcript (ES_RAW_TRANSCRIPT=1), which carry the native events. The known
// signatures are committed in test/replay/formats/<harness>.json; a signature outside them means
// the CLI's output format changed, and the contract fails on it (the drift job's loud failure).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { testDir } from './fixture.ts'

type Format = {
  /** What kind of event this is, e.g. `step_update/tool`. */
  kind: (event: Record<string, unknown>) => string | undefined
  /** Subtrees whose keys vary with the tool or the model (tool inputs and outputs): keys not kept. */
  opaque: string[]
  /** Keys whose values are part of the format (states, statuses). */
  values: string[]
  /** Lists whose string members are part of the format (the tools the CLI advertises). */
  lists: string[]
}

const FORMATS: Record<string, Format> = {
  antigravity: {
    kind: (e) => {
      if (typeof e.event !== 'string') return undefined
      const step = (e.step_update as { step_type?: unknown } | undefined)?.step_type
      return typeof step === 'string' ? `${e.event}/${step}` : e.event
    },
    opaque: ['parameters', 'output', 'structured_output'],
    values: ['state', 'status', 'permission_mode'],
    lists: ['tools'],
  },
  // The Cursor SDK harness's runner lines: `init`, `event` (the SDK's own messages), `result`.
  cursor: {
    kind: (e) => {
      if (typeof e.type !== 'string') return undefined
      const inner = (e.event as { type?: unknown } | undefined)?.type
      return typeof inner === 'string' ? `${e.type}/${inner}` : e.type
    },
    opaque: ['args', 'value', 'params', 'result'],
    values: ['status', 'role'],
    lists: [],
  },
  // OpenCode's ACP `session/update`s, by `sessionUpdate`, and its `session/prompt` response.
  opencode: {
    kind: (e) =>
      typeof e.sessionUpdate === 'string'
        ? e.sessionUpdate
        : typeof e.stopReason === 'string'
          ? 'prompt-response'
          : undefined,
    opaque: [
      'rawInput',
      'rawOutput',
      'content',
      'locations',
      'availableCommands',
      'configOptions',
      '_meta',
    ],
    values: ['status', 'kind', 'stopReason'],
    lists: [],
  }, // Goose's ACP `session/update`s, by `sessionUpdate`, and its `session/prompt` response.
  goose: {
    kind: (e) =>
      typeof e.sessionUpdate === 'string'
        ? e.sessionUpdate
        : typeof e.stopReason === 'string'
          ? 'prompt-response'
          : undefined,
    opaque: [
      'rawInput',
      'rawOutput',
      'content',
      'locations',
      'availableCommands',
      'configOptions',
      '_meta',
    ],
    values: ['status', 'kind', 'stopReason'],
    lists: [],
  },
  // pi's `--mode json` events, by `type` (and the assistant event inside `message_update`).
  pi: {
    kind: (e) => {
      if (typeof e.type !== 'string') return undefined
      const inner = (e.assistantMessageEvent as { type?: unknown } | undefined)?.type
      const role = (e.message as { role?: unknown } | undefined)?.role
      return typeof inner === 'string'
        ? `${e.type}/${inner}`
        : typeof role === 'string'
          ? `${e.type}/${role}`
          : e.type
    },
    opaque: [
      'arguments',
      'args',
      'content',
      'result',
      'partialResult',
      'sections',
      'messages',
      'errorMessage',
      'details',
      'thoughtSignature',
      'delta',
      'toolCall',
    ],
    values: ['stopReason', 'role', 'api', 'provider'],
    lists: [],
  },
}

export const hasFormat = (harness: string) => Object.hasOwn(FORMATS, harness)

/** The native events in a raw transcript: the `raw` parts' values that the CLI sent as JSON. */
export function nativeEvents(rawTranscript: string): Record<string, unknown>[] {
  return rawTranscript
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const part = (JSON.parse(line) as { part?: { type?: string; rawValue?: unknown } }).part
      const value = part?.type === 'raw' ? part.rawValue : undefined
      return value && typeof value === 'object' && !('unparsed' in value)
        ? [value as Record<string, unknown>]
        : []
    })
}

/** Every signature in the events, sorted. */
export function signatures(harness: string, events: Record<string, unknown>[]): string[] {
  const f = FORMATS[harness]
  if (!f) return []
  const out = new Set<string>()
  const walk = (value: unknown, kind: string, path: string) => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v, kind, `${path}[]`)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, v] of Object.entries(value)) {
      const at = `${path}.${key}`
      out.add(`${kind} ${at}`)
      if (f.opaque.includes(key)) continue
      if (f.values.includes(key) && typeof v === 'string') out.add(`${kind} ${at}=${v}`)
      if (f.lists.includes(key) && Array.isArray(v)) {
        for (const item of v) if (typeof item === 'string') out.add(`${kind} ${at}[]=${item}`)
        continue
      }
      walk(v, kind, at)
    }
  }
  for (const e of events) {
    const kind = f.kind(e)
    if (!kind) {
      out.add(`unknown event ${JSON.stringify(Object.keys(e).sort())}`)
      continue
    }
    walk(e, kind, '')
  }
  return [...out].sort()
}

const formatsFile = (harness: string) => join(testDir, 'replay', 'formats', `${harness}.json`)

export const knownSignatures = (harness: string): string[] =>
  existsSync(formatsFile(harness))
    ? (JSON.parse(readFileSync(formatsFile(harness), 'utf8')) as string[])
    : []

/** Adds `seen` to the known signatures (ES_UPDATE_FORMATS=1). */
export function learnSignatures(harness: string, seen: string[]): void {
  const all = [...new Set([...knownSignatures(harness), ...seen])].sort()
  writeFileSync(formatsFile(harness), `${JSON.stringify(all, null, 2)}\n`)
}

/** Every `transcript.raw.jsonl` under `dir`. */
export function rawTranscripts(dir: string): string[] {
  const found: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name === 'transcript.raw.jsonl') found.push(join(d, e.name))
    }
  }
  walk(dir)
  return found
}
