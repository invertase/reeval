// A harness adapter that plays a script, one entry per turn, and records what it was given: the
// AI SDK's contract, with no CLI behind it.
import type { HarnessV1, HarnessV1StreamPart } from '@ai-sdk/harness'
import type { AdapterInput, AgentHarness } from '../src/session.ts'

type Emit = (part: HarnessV1StreamPart) => void

/** A turn's parts, or a function that emits them and may wait on the turn's abort. */
export type ScriptedTurn =
  | HarnessV1StreamPart[]
  | ((emit: Emit, signal: AbortSignal) => Promise<void>)

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** A turn that streams `text` and finishes, as a CLI that answered does. */
export function reply(text: string, extra: HarnessV1StreamPart[] = []): HarnessV1StreamPart[] {
  return [
    { type: 'stream-start', modelId: 'served-model' },
    ...extra,
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, totalUsage: USAGE },
  ] as HarnessV1StreamPart[]
}

export type Scripted = {
  harness: AgentHarness
  /** What `adapter()` was built from, each time. */
  inputs: AdapterInput[]
  /** The skills each turn was given. */
  skills: unknown[][]
  prompts: string[]
  /** What happened, in order: `start`, `turn <n>`, `destroy`. */
  calls: string[]
}

export function scripted(turns: ScriptedTurn[], fail?: Error): Scripted {
  const record: Scripted = {
    inputs: [],
    skills: [],
    prompts: [],
    calls: [],
    harness: {
      kind: 'cursor',
      model: 'composer-test',
      adapter: (input) => {
        record.inputs.push(input)
        return adapter
      },
    },
  }
  const done = { submitToolResult: async () => {}, done: Promise.resolve() }
  const adapter = {
    specificationVersion: 'harness-v1',
    harnessId: 'scripted',
    builtinTools: {},
    doStart: async ({ sessionId }: { sessionId: string }) => {
      record.calls.push('start')
      if (fail) throw fail
      return {
        sessionId,
        isResume: false,
        doPromptTurn: async (turn: {
          prompt: string
          emit: Emit
          abortSignal?: AbortSignal
          skills?: unknown[]
        }) => {
          const n = record.prompts.push(turn.prompt) - 1
          record.skills.push(turn.skills ?? [])
          record.calls.push(`turn ${n}`)
          const script = turns[n] ?? reply('nothing scripted')
          if (Array.isArray(script)) {
            for (const part of script) turn.emit(part)
            return done
          }
          const signal = turn.abortSignal ?? new AbortController().signal
          return { submitToolResult: async () => {}, done: script(turn.emit, signal) }
        },
        doCompact: async () => {},
        doContinueTurn: async () => done,
        doSuspendTurn: async () => ({}),
        doDetach: async () => ({}),
        doStop: async () => ({}),
        doDestroy: async () => {
          record.calls.push('destroy')
        },
      }
    },
  } as unknown as HarnessV1
  return record
}
