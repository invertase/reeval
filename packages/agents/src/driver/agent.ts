import type { HarnessV1, HarnessV1Session, HarnessV1StreamPart } from '@ai-sdk/harness'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import type { AgentKind, HarnessEntry, HarnessUsage } from '../catalog/entry.ts'
import { AgentError } from '../errors.ts'
import type { Runner } from '../runner.ts'
import { type RunnerSessionOptions, runnerSession } from '../runner-session.ts'
import type { CostUsd, TokenUsage, TranscriptEvent, TurnStatus } from '../types.ts'
import { addUsage, tokenUsage } from '../usage.ts'
import { providerStop } from './provider-stop.ts'
import {
  errorText,
  normalizeStream,
  reasoningTime,
  type StampedPart,
  timesReasoning,
} from './transcript.ts'
import type { AgentLog, HarnessResult, HarnessSession } from './types.ts'

/** A stream part into the attempt's trace, and each tool call as a `-v` line as it happens. */
function traceStreamPart(
  log: AgentLog,
  part: StampedPart['part'],
  ms: number,
  tools: Map<string, { name: string; at: number }>,
) {
  const p = part as { type: string; toolCallId?: string; toolName?: string; error?: unknown }
  log.trace(
    'harness',
    'stream',
    { ms, part },
    p.type.endsWith('-delta') ? false : `stream ${p.type}`,
  )
  if (p.type === 'tool-call' && p.toolCallId) {
    const name = p.toolName ?? 'tool'
    tools.set(p.toolCallId, { name, at: ms })
    log.log('harness', `tool ${name} called (${p.toolCallId})`)
  } else if ((p.type === 'tool-result' || p.type === 'tool-error') && p.toolCallId) {
    const call = tools.get(p.toolCallId)
    const took = call ? ` in ${ms - call.at}ms` : ''
    const how = p.type === 'tool-error' ? `failed: ${errorText(p.error)}` : 'returned'
    log.log('harness', `tool ${call?.name ?? p.toolName ?? 'tool'} ${how}${took} (${p.toolCallId})`)
  } else if (p.type === 'error') {
    log.log('harness', `stream error: ${errorText(p.error)}`)
  }
}

/**
 * Each turn's cost from what the harness reports on its finish: a session's running total, as
 * Claude Code's is, less what its earlier turns reported. A total that fell, or a session other
 * than the attempt's first, can't be split into turns, so that turn has no reported cost; nor
 * has one the harness put at $0, which it says for a model its own prices don't list.
 */
export function turnCosts(
  reported: HarnessEntry['reportedCost'],
  source: string,
): (harnessMetadata: unknown) => CostUsd | undefined {
  let session: string | undefined
  let before = 0
  return (harnessMetadata) => {
    const said = reported?.(harnessMetadata)
    if (!said) return undefined
    let usd = said.usd
    if (said.session !== undefined) {
      const same = session === undefined || session === said.session
      const fell = said.usd < before
      session ??= said.session
      if (!same) return undefined
      usd = Math.round((said.usd - before) * 1e9) / 1e9
      before = said.usd
      if (fell) return undefined
    }
    return usd > 0 ? { usd, basis: 'reported', source } : undefined
  }
}

type Usage = Parameters<typeof tokenUsage>[0]

/** How long reading a CLI's stored usage gets, past which the turn keeps none. */
const STORED_USAGE_MS = 5_000

/** An adapter's usage, in the AI SDK's provider shape, as a transcript's; null when it counts nothing. */
export function harnessUsage(usage: HarnessUsage): TokenUsage | null {
  const { inputTokens: input, outputTokens: output } = usage
  if (input.total === undefined && output.total === undefined) return null
  const cacheRead = input.cacheRead ?? 0
  const cacheWrite = input.cacheWrite ?? 0
  return {
    input: input.noCache ?? Math.max((input.total ?? 0) - cacheRead - cacheWrite, 0),
    output: output.total ?? 0,
    cacheRead,
    cacheWrite,
    reasoning: output.reasoning ?? null,
  }
}

/**
 * The adapter, with every part its sessions emit also passed to `onPart`. `HarnessAgent` keeps
 * the `stream-start` part's `modelId` (the model the runtime resolved) to itself.
 */
export function observed(
  adapter: HarnessV1,
  onPart: (part: HarnessV1StreamPart) => void,
): HarnessV1 {
  const session = (s: HarnessV1Session): HarnessV1Session =>
    new Proxy(s, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        if (key !== 'doPromptTurn' && key !== 'doContinueTurn') return value
        return (turn: { emit: (part: HarnessV1StreamPart) => void }) =>
          value.call(target, {
            ...turn,
            emit: (part: HarnessV1StreamPart) => {
              onPart(part)
              turn.emit(part)
            },
          })
      },
    })
  return new Proxy(adapter, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key !== 'doStart') return value
      return async (...args: unknown[]) => session(await value.apply(target, args))
    },
  })
}

/**
 * The built-in tools that wait on a person, which an unattended agent has none of. Claude Code's
 * `AskUserQuestion` ends the turn on a tool call only the host answers, and the session takes no
 * new prompt until it gets one, so the agent is never offered it and asks in its reply instead.
 */
const INTERACTIVE_TOOLS = ['askUserQuestions']

/** The adapter's built-in tools the driver turns off: those of {@link INTERACTIVE_TOOLS} it offers. */
export function interactiveTools(adapter: HarnessV1): string[] {
  return INTERACTIVE_TOOLS.filter((name) => Object.hasOwn(adapter.builtinTools, name))
}

/**
 * The turn's error when every model call the runner's network saw in it got an HTTP error,
 * naming the statuses; undefined when one succeeded or it saw none.
 */
export function everyCallFailed(name: string, statuses: readonly number[]): string | undefined {
  if (statuses.length === 0 || statuses.some((s) => s < 400)) return undefined
  return `every ${name} model call in the turn failed (HTTP ${[...new Set(statuses)].join(', ')})`
}

/**
 * How the APIs behind the harnesses say they refused a key: an HTTP 401, Anthropic's and OpenAI's
 * wording, Google's (which answers 400), and OpenCode's for any provider's 401 or 403. A bare 403
 * isn't here: proxies and MCP servers send those for reasons that have nothing to do with the
 * harness's key. Grok Build checks its key as it starts and, when xAI refuses it (a 400 or 401,
 * not an outage), offers no `xai.api_key` sign-in, which is all `@ai-sdk/harness-acp` reports.
 */
export const REFUSED_KEY =
  /\bHTTP 401\b|\b401\b.{0,40}\bunauthori[sz]ed\b|\bunauthori[sz]ed\b.{0,40}\b401\b|\b(?:invalid|incorrect) (?:x-)?api[ _-]?key\b|\bapi key not valid\b|\bAPI_KEY_INVALID\b|\bauthentication_error\b|\bprovider authentication required\b|\bauthentication method "xai\.api_key" is not advertised\b/i

/**
 * The turn's refused-key error (`hinted`, the first error `authHint` named the key in) when the API
 * rejected the harness's key for the whole turn: the turn errored, or every model call failed,
 * and no call the runner's network saw succeeded. A key that served one call isn't rejected,
 * whatever the turn's error says: a 401 the CLI retried past, or refused-key wording that came
 * from elsewhere (a tool's or MCP server's output in the CLI's stderr).
 */
export function rejectedKey(turn: {
  hinted: string | undefined
  status: TurnStatus
  statuses: readonly number[]
}): string | undefined {
  const { hinted, status, statuses } = turn
  if (!hinted || status === 'aborted' || statuses.some((s) => s < 400)) return undefined
  return status === 'error' || statuses.length > 0 ? hinted : undefined
}

/** The model calls a runner's network saw, for a runner whose network sees them. */
export type ModelTraffic = {
  /** Each model call's HTTP status, in order. */
  statuses(): readonly number[]
  /** The model each model call's response named, in order. */
  servedModels(): readonly string[]
}

export type StartAgentOptions = {
  kind: AgentKind
  entry: Pick<
    HarnessEntry,
    | 'name'
    | 'reportedCost'
    | 'storedUsage'
    | 'configuredModelOnStart'
    | 'fullToolOutput'
    | 'reasoning'
    | 'unreported'
  >
  /** The harness's AI SDK adapter, with its auth, model and MCP servers. */
  adapter: HarnessV1
  model: string
  runner: Runner
  /** What the session the adapter drives says of itself. */
  session?: RunnerSessionOptions
  /** The workspace the agent works in, relative to the runner's `cwd`. */
  workDir: string
  skills?: ConstructorParameters<typeof HarnessAgent>[0]['skills']
  /** Aborting it stops the session starting. */
  signal: AbortSignal
  log: AgentLog
  /** Where the runner's network saw the agent's model calls, which say a turn was refused. */
  traffic?: ModelTraffic
  /** What to do about an error that may be a refused key; `refused` when a model call got a 401. */
  authHint?: (message: string, refused: boolean) => string | undefined
  /** {@link normalizeStream}'s `workspace`. */
  workspace?: RegExp
  /** Keep every stream part on each turn's result, as `raw`. */
  raw?: boolean
  /** Each stream part of a turn, as it arrives. */
  onPart?: (part: StampedPart) => void
  /** Called when the session closes, or fails to start. */
  onClose?: () => void
}

/**
 * Starts a real agent's session on `runner` through its AI SDK harness adapter. Each `send` is a
 * turn, whose result is its normalized transcript, usage, served model and cost, and whether the
 * key was refused or the provider stopped it. Failing to start throws an {@link AgentError}.
 */
export async function startAgent(options: StartAgentOptions): Promise<HarnessSession> {
  const { kind, entry, adapter, model, runner, signal, log, traffic, authHint } = options
  const close = options.onClose ?? (() => {})
  let servedModel: string | null = null
  let finishMetadata: unknown
  const turnCost = turnCosts(entry.reportedCost, kind)
  const off = interactiveTools(adapter)
  const agent = new HarnessAgent({
    harness: observed(adapter, (part) => {
      if (part.type === 'stream-start' && part.modelId && !entry.configuredModelOnStart)
        servedModel = part.modelId
      if (part.type === 'finish') finishMetadata = part.harnessMetadata
    }),
    model,
    permissionMode: 'allow-all',
    ...(off.length ? { inactiveTools: off } : {}),
    sandboxConfig: { workDir: options.workDir },
    ...(options.skills?.length ? { skills: options.skills } : {}),
  })
  const statuses = () => traffic?.statuses() ?? []
  let network: Awaited<ReturnType<typeof runnerSession>> | undefined
  const release = () => Promise.resolve(network?.destroy()).catch(() => {})
  let session: Awaited<ReturnType<typeof agent.createSession>>
  try {
    network = await runnerSession(runner, options.session)
    session = await agent.createSession({ sandboxSession: network, abortSignal: signal })
  } catch (error) {
    close()
    await release()
    if (signal.aborted) throw error
    const message = (error as Error).message
    const hint = authHint?.(message, statuses().includes(401))
    throw new AgentError(
      `${hint ? `${hint}. ` : ''}${entry.name} harness failed to start: ${message}`,
      { transient: !hint && (error as { transient?: unknown }).transient === true },
    )
  }
  const started = network
  let usageMark: string | undefined
  const storedUsage = async (since: number): Promise<TokenUsage | null> => {
    const store = await entry.storedUsage?.()
    if (!store) return null
    const command = store.command({ since, ...(usageMark ? { mark: usageMark } : {}) })
    const read = await Promise.resolve(
      started.run({ command, abortSignal: AbortSignal.timeout(STORED_USAGE_MS) }),
    )
      .then(({ exitCode, stdout, stderr }) => {
        if (exitCode !== 0) throw new Error(`exit ${exitCode}: ${stderr.trim().slice(-300)}`)
        return store.parse(stdout)
      })
      .catch((error: unknown) => {
        log.log('harness', `reading ${entry.name}'s stored usage failed: ${errorText(error)}`)
        return undefined
      })
    if (!read) {
      log.log('harness', `no usage in ${entry.name}'s store since the turn began`)
      return null
    }
    if (read.mark) usageMark = read.mark
    const usage = harnessUsage(read.usage)
    const calls = `${read.calls} model call${read.calls === 1 ? '' : 's'}`
    log.log(
      'harness',
      `usage read back from ${entry.name}'s store: ${calls}${usage ? ` · ${usage.input} in · ${usage.output} out` : ''}`,
    )
    return usage
  }
  let running: ((note: TranscriptEvent) => Promise<HarnessResult>) | undefined
  let turn: { startedAt: number; salvaged?: Promise<TokenUsage | null> } | undefined
  return {
    async send(prompt, turnSignal) {
      const startedAt = Date.now()
      const current: NonNullable<typeof turn> = { startedAt }
      turn = current
      const parts: StampedPart[] = []
      const servedBefore = traffic?.servedModels().length ?? 0
      const seenBefore = statuses().length
      servedModel = null
      finishMetadata = undefined
      let stepUsage: TokenUsage | null = null
      const steps: TokenUsage[] = []
      // A turn whose stream reported no usage takes what its CLI stored for the turn's model
      // calls: an aborted turn's stream ends before the usage it would have sent.
      const finish = async (
        text: string,
        status: TurnStatus,
        extra: TranscriptEvent[] = [],
        reported: TokenUsage | null = stepUsage,
      ): Promise<HarnessResult> => {
        const usage = reported ?? (await (current.salvaged ?? storedUsage(startedAt)))
        const seen = statuses().slice(seenBefore)
        const refused = seen.includes(401)
        // A block that arrived whole was never timed, whatever its start and end parts say.
        const normalized = normalizeStream(parts, startedAt, {
          ...(entry.fullToolOutput ? { fullToolOutput: entry.fullToolOutput } : {}),
          ...(options.workspace ? { workspace: options.workspace } : {}),
        })
        const events = [...normalized, ...extra].map((e) =>
          e.type === 'reasoning' && !timesReasoning(entry.reasoning)
            ? { ...e, durationMs: null }
            : e,
        )
        const failed = everyCallFailed(entry.name, seen)
        // A CLI can end a turn as if it worked when its API refused every call (fx does).
        if (status === 'completed' && failed && !events.some((e) => e.type === 'error')) {
          const at = Date.now() - startedAt
          status = 'error'
          events.push({
            type: 'error',
            message: failed,
            ts: new Date(startedAt + at).toISOString(),
            atMs: at,
          })
        }
        let hinted: string | undefined
        const transcript = events.map((e) => {
          if (e.type !== 'error') return e
          const hint = authHint?.(e.message, refused)
          if (!hint) return e
          const message = `${hint}. ${e.message}`
          hinted ??= message
          return { ...e, message }
        })
        const rejected = rejectedKey({ hinted, status, statuses: seen })
        const stopped = rejected
          ? undefined
          : providerStop({
              errors: transcript.flatMap((e) => (e.type === 'error' ? [e.message] : [])),
              status,
              statuses: seen,
            })
        const cost = turnCost(finishMetadata)
        return {
          text,
          status,
          usage,
          ...(cost ? { cost } : {}),
          // An adapter that doesn't say takes the network's word: the turn's last model call.
          model: servedModel ?? traffic?.servedModels().slice(servedBefore).at(-1) ?? null,
          unreported: entry.unreported?.(finishMetadata) ?? [],
          steps,
          reasoningMs: reasoningTime(entry.reasoning, transcript, usage),
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          transcript,
          ...(rejected ? { rejectedKey: rejected } : {}),
          ...(stopped ? { providerStop: stopped } : {}),
          ...(options.raw ? { raw: parts } : {}),
        }
      }
      running = (note) => finish('', 'aborted', [note])
      try {
        // stream(), not generate(): only the stream says when each event happened.
        const result = await agent.stream({ session, prompt, abortSignal: turnSignal })
        const tools = new Map<string, { name: string; at: number }>()
        for await (const part of result.fullStream) {
          const ms = Date.now() - startedAt
          const stamped: StampedPart = { ms, part: part as StampedPart['part'] }
          parts.push(stamped)
          options.onPart?.(stamped)
          traceStreamPart(log, stamped.part, ms, tools)
          if (part.type === 'finish-step') {
            const step = tokenUsage(part.usage as Usage)
            if (step) steps.push(step)
            stepUsage = addUsage(stepUsage, step)
          }
        }
        const reported = await result.totalUsage
        const total = tokenUsage(reported)
        const mark = (await entry.storedUsage?.())?.mark?.((reported as { raw?: unknown }).raw)
        if (mark) usageMark = mark
        // A turn the abort cut short can still end its stream cleanly.
        const status = turnSignal.aborted ? 'aborted' : 'completed'
        return finish(await result.text, status, [], total ?? stepUsage)
      } catch (error) {
        const message = errorText(error)
        const at = Date.now() - startedAt
        // An adapter's `error` part is thrown here too: record the failure once.
        const reported = parts.some(
          ({ part }) => part.type === 'error' && errorText(part.error) === message,
        )
        return finish(
          '',
          turnSignal.aborted ? 'aborted' : 'error',
          reported
            ? []
            : [
                {
                  type: 'error',
                  message,
                  ts: new Date(startedAt + at).toISOString(),
                  atMs: at,
                },
              ],
        )
      } finally {
        if (turn === current) turn = undefined
      }
    },
    stopped: (note) => (running ? running(note) : Promise.reject(new Error('No turn is running'))),
    salvage: async () => {
      if (!turn) return
      turn.salvaged ??= storedUsage(turn.startedAt)
      await turn.salvaged
    },
    close: async () => {
      close()
      await session.destroy().catch(() => {})
      await release()
    },
  }
}
