import type { HarnessV1, HarnessV1Session, HarnessV1StreamPart } from '@ai-sdk/harness'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { WORKSPACE_DIR } from '@reeval/sandbox-docker'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { brokerToken } from '../gateway/token.ts'
import type { SandboxAdc, VertexSettings } from '../gateway/vertex.ts'
import { capabilitiesOf, runsAgent, sandboxKind, suggestedSandbox } from '../sandbox/kinds.ts'
import { hasNetworkSession, InfraError, type Sandbox } from '../sandbox/types.ts'
import { plural } from '../text.ts'
import type {
  AgentHarnessDescriptor,
  CostUsd,
  SandboxDescriptor,
  TokenUsage,
  TranscriptEvent,
  TurnStatus,
} from '../types.ts'
import { addUsage, tokenUsage } from '../usage.ts'
import {
  type AdapterVertex,
  type Agent,
  agentAuth,
  agentFor,
  agentMcp,
  authHint,
  type HarnessUsage,
  unverifiedHarness,
  writePluginFiles,
} from './agents.ts'
import { providerStop } from './provider-stop.ts'
import {
  errorText,
  normalizeStream,
  reasoningTime,
  type StampedPart,
  timesReasoning,
} from './transcript.ts'
import type { Harness, HarnessResult } from './types.ts'

/** A stream part into the attempt's trace, and each tool call as a `-v` line as it happens. */
function traceStreamPart(
  part: StampedPart['part'],
  ms: number,
  tools: Map<string, { name: string; at: number }>,
) {
  const p = part as { type: string; toolCallId?: string; toolName?: string; error?: unknown }
  debugTrace(
    'harness',
    'stream',
    { ms, part },
    p.type.endsWith('-delta') ? false : `stream ${p.type}`,
  )
  if (p.type === 'tool-call' && p.toolCallId) {
    const name = p.toolName ?? 'tool'
    tools.set(p.toolCallId, { name, at: ms })
    debugLog('harness', `tool ${name} called (${p.toolCallId})`)
  } else if ((p.type === 'tool-result' || p.type === 'tool-error') && p.toolCallId) {
    const call = tools.get(p.toolCallId)
    const took = call ? ` in ${ms - call.at}ms` : ''
    const how = p.type === 'tool-error' ? `failed: ${errorText(p.error)}` : 'returned'
    debugLog(
      'harness',
      `tool ${call?.name ?? p.toolName ?? 'tool'} ${how}${took} (${p.toolCallId})`,
    )
  } else if (p.type === 'error') {
    debugLog('harness', `stream error: ${errorText(p.error)}`)
  }
}

/**
 * Each turn's cost from what the harness reports on its finish: a session's running total, as
 * Claude Code's is, less what its earlier turns reported. A total that fell, or a session other
 * than the attempt's first, can't be split into turns, so that turn has no reported cost; nor
 * has one the harness put at $0, which it says for a model its own prices don't list.
 */
export function turnCosts(
  reported: Agent['reportedCost'],
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

/** An adapter's usage, in the AI SDK's provider shape, as reeval's; null when it counts nothing. */
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
 * The built-in tools that wait on a person, which an eval has none of. Claude Code's
 * `AskUserQuestion` ends the turn on a tool call only the host answers, and the session takes no
 * new prompt until it gets one, so the agent is never offered it and asks in its reply instead.
 */
const INTERACTIVE_TOOLS = ['askUserQuestions']

/** The adapter's built-in tools reeval turns off: those of {@link INTERACTIVE_TOOLS} it offers. */
export function interactiveTools(adapter: HarnessV1): string[] {
  return INTERACTIVE_TOOLS.filter((name) => Object.hasOwn(adapter.builtinTools, name))
}

/**
 * The turn's error when every model call the egress gateway brokered in it got an HTTP error,
 * naming the statuses; undefined when one succeeded or none was brokered.
 */
export function everyCallFailed(name: string, statuses: readonly number[]): string | undefined {
  if (statuses.length === 0 || statuses.some((s) => s < 400)) return undefined
  return `every ${name} model call in the turn failed (HTTP ${[...new Set(statuses)].join(', ')})`
}

/**
 * The turn's refused-key error (`hinted`, the first error `authHint` named the key in) when the API
 * rejected the harness's key for the whole turn: the turn errored, or every brokered call failed,
 * and no call the gateway brokered with the key in it succeeded. A key that served one call isn't
 * rejected, whatever the turn's error says: a 401 the CLI retried past, or refused-key wording
 * that came from elsewhere (a tool's or MCP server's output in the CLI's stderr).
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

/** The route's service account, written beside the workspace, as the adapter takes it. */
async function writeAdc(sandbox: Sandbox, adc: SandboxAdc): Promise<AdapterVertex> {
  await sandbox.writeFile(`../${adc.file}`, adc.content)
  const credentialsFile = `${sandbox.workdir.replace(/[\\/][^\\/]*$/, '')}/${adc.file}`
  debugLog('env', `Vertex AI service account → ${credentialsFile}`)
  return { project: adc.project, location: adc.location, credentialsFile }
}

/**
 * Why `agent` can't run in `sandbox`: its kind has no harness session, can't keep the agent's
 * credential out of it, or runs a platform the agent's bootstrap has no build for.
 */
export function agentSandboxProblem(
  harness: AgentHarnessDescriptor,
  agent: Agent,
  sandbox: SandboxDescriptor,
): string | undefined {
  const unverified = unverifiedHarness(harness, sandbox)
  if (unverified) return unverified
  const fits = runsAgent(harness.kind, agent.platforms)
  const can = capabilitiesOf(sandbox)
  if (fits(can)) return undefined
  // Only a sandbox with a harness session runs the bootstrap, so only its platform matters.
  const lacks = [
    ...(can.harnessSession ? [] : ['has no harness session']),
    ...(can.brokers ? [] : [`can't keep ${agent.credential} out of it`]),
    ...(!can.harnessSession || agent.platforms.includes(can.platform)
      ? []
      : [`runs ${can.platform}, not ${agent.platforms.join(' or ')}`]),
  ]
  const fix = suggestedSandbox(fits)
  return `The ${agent.name} harness can't run in the ${sandboxKind(sandbox).provider(sandbox)} sandbox, which ${lacks.join(' and ')}: ${fix ? `set sandbox: ${fix} for this eval, or ` : ''}use fakeHarness() with fakeSandbox()`
}

/** A real agent through its AI SDK harness adapter, in a sandbox that gives it a harness session. */
export function createAgentHarness(
  descriptor: AgentHarnessDescriptor,
  sandbox: SandboxDescriptor,
  vertex?: VertexSettings,
): Harness {
  const catalog = agentFor(descriptor, vertex)
  const problem = agentSandboxProblem(descriptor, catalog, sandbox)
  if (problem) throw new InfraError(problem)
  return {
    async start(sandbox, signal, { skills, mcp, plugins }) {
      const auth = agentAuth(catalog)
      let servedModel: string | null = null
      let finishMetadata: unknown
      const turnCost = turnCosts(catalog.reportedCost, descriptor.kind)
      const servers = agentMcp(catalog, mcp, plugins)
      const model = catalog.modelId?.(descriptor.model) ?? descriptor.model
      const vertex = catalog.adc ? await writeAdc(sandbox, catalog.adc) : undefined
      const adapter = await catalog.adapter({
        auth,
        ...(catalog.routeEnv ? { env: catalog.routeEnv } : {}),
        ...(vertex ? { vertex } : {}),
        ...(catalog.vertexChat ? { vertexChat: catalog.vertexChat } : {}),
        descriptor,
        model,
        plugins,
        ...(Object.keys(servers).length ? { mcpServers: catalog.mcpServers(servers) } : {}),
      })
      for (const path of await writePluginFiles(sandbox, catalog, plugins)) {
        debugLog('env', `plugin settings → ${path}`)
      }
      const off = interactiveTools(adapter as HarnessV1)
      const agent = new HarnessAgent({
        harness: observed(adapter as HarnessV1, (part) => {
          if (part.type === 'stream-start' && part.modelId && !catalog.configuredModelOnStart)
            servedModel = part.modelId
          if (part.type === 'finish') finishMetadata = part.harnessMetadata
        }),
        model,
        permissionMode: 'allow-all',
        ...(off.length ? { inactiveTools: off } : {}),
        sandboxConfig: { workDir: WORKSPACE_DIR },
        ...(skills.length ? { skills } : {}),
      })
      if (!hasNetworkSession(sandbox)) {
        throw new InfraError(`The ${catalog.name} harness got a sandbox with no harness session`)
      }
      const refusedSince = (from: number) =>
        (sandbox.brokeredStatuses?.() ?? []).slice(from).includes(401)
      let stopToken = () => {}
      if (catalog.token) {
        try {
          stopToken = await brokerToken(catalog.token, sandbox.network, {
            onRefresh: (t) =>
              debugLog(
                'broker',
                `access token refreshed, valid until ${new Date(t.expiresAt).toISOString()}`,
              ),
            onError: (error) =>
              debugLog('broker', `access token refresh failed, retrying: ${errorText(error)}`),
          })
        } catch (error) {
          throw new InfraError(
            `Couldn't mint an access token from ${catalog.credential} for ${catalog.name}: ${errorText(error)}. Run gcloud auth application-default login, or set GOOGLE_APPLICATION_CREDENTIALS.`,
          )
        }
        debugLog('broker', `gateway adds an access token from ${catalog.credential}`)
      }
      let session: Awaited<ReturnType<typeof agent.createSession>>
      try {
        session = await agent.createSession({
          sandboxSession: sandbox.network,
          abortSignal: signal,
        })
      } catch (error) {
        stopToken()
        if (signal.aborted) throw error
        const message = (error as Error).message
        const hint = authHint(catalog, message, refusedSince(0))
        throw new InfraError(
          `${hint ? `${hint}. ` : ''}${catalog.name} harness failed to start: ${message}`,
          { transient: !hint && (error as { transient?: unknown }).transient === true },
        )
      }
      const network = sandbox.network
      let usageMark: string | undefined
      const storedUsage = async (since: number): Promise<TokenUsage | null> => {
        const store = await catalog.storedUsage?.()
        if (!store) return null
        const command = store.command({ since, ...(usageMark ? { mark: usageMark } : {}) })
        const read = await Promise.resolve(
          network.run({ command, abortSignal: AbortSignal.timeout(STORED_USAGE_MS) }),
        )
          .then(({ exitCode, stdout, stderr }) => {
            if (exitCode !== 0) throw new Error(`exit ${exitCode}: ${stderr.trim().slice(-300)}`)
            return store.parse(stdout)
          })
          .catch((error: unknown) => {
            debugLog(
              'harness',
              `reading ${catalog.name}'s stored usage failed: ${errorText(error)}`,
            )
            return undefined
          })
        if (!read) {
          debugLog('harness', `no usage in ${catalog.name}'s store since the turn began`)
          return null
        }
        if (read.mark) usageMark = read.mark
        const usage = harnessUsage(read.usage)
        debugLog(
          'harness',
          `usage read back from ${catalog.name}'s store: ${plural(read.calls, 'model call')}${usage ? ` · ${usage.input} in · ${usage.output} out` : ''}`,
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
          const servedBefore = sandbox.servedRequests?.().length ?? 0
          const brokeredBefore = sandbox.brokeredStatuses?.().length ?? 0
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
            const statuses = sandbox.brokeredStatuses?.().slice(brokeredBefore) ?? []
            const refused = statuses.includes(401)
            // A block that arrived whole was never timed, whatever its start and end parts say.
            const normalized = normalizeStream(parts, startedAt, {
              ...(catalog.fullToolOutput ? { fullToolOutput: catalog.fullToolOutput } : {}),
            })
            const events = [...normalized, ...extra].map((e) =>
              e.type === 'reasoning' && !timesReasoning(catalog.reasoning)
                ? { ...e, durationMs: null }
                : e,
            )
            const failed = everyCallFailed(catalog.name, statuses)
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
              const hint = authHint(catalog, e.message, refused)
              if (!hint) return e
              const message = `${hint}. ${e.message}`
              hinted ??= message
              return { ...e, message }
            })
            const rejected = rejectedKey({ hinted, status, statuses })
            const stopped = rejected
              ? undefined
              : providerStop({
                  errors: transcript.flatMap((e) => (e.type === 'error' ? [e.message] : [])),
                  status,
                  statuses,
                })
            const cost = turnCost(finishMetadata)
            return {
              text,
              status,
              usage,
              ...(cost ? { cost } : {}),
              // An adapter that doesn't say takes the gateway's word: the turn's last brokered call.
              model: servedModel ?? sandbox.servedRequests?.().slice(servedBefore).at(-1) ?? null,
              unreported: catalog.unreported?.(finishMetadata) ?? [],
              steps,
              reasoningMs: reasoningTime(catalog.reasoning, transcript, usage),
              startedAt: new Date(startedAt).toISOString(),
              durationMs: Date.now() - startedAt,
              transcript,
              ...(rejected ? { rejectedKey: rejected } : {}),
              ...(stopped ? { providerStop: stopped } : {}),
              ...(process.env.REEVAL_RAW_TRANSCRIPT ? { raw: parts } : {}),
            }
          }
          running = (note) => finish('', 'aborted', [note])
          try {
            // stream(), not generate(): only the stream says when each event happened.
            const result = await agent.stream({ session, prompt, abortSignal: turnSignal })
            const tools = new Map<string, { name: string; at: number }>()
            for await (const part of result.fullStream) {
              const ms = Date.now() - startedAt
              parts.push({ ms, part: part as StampedPart['part'] })
              traceStreamPart(part as StampedPart['part'], ms, tools)
              if (part.type === 'finish-step') {
                const step = tokenUsage(part.usage as Usage)
                if (step) steps.push(step)
                stepUsage = addUsage(stepUsage, step)
              }
            }
            const reported = await result.totalUsage
            const total = tokenUsage(reported)
            const mark = (await catalog.storedUsage?.())?.mark?.(
              (reported as { raw?: unknown }).raw,
            )
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
        stopped: (note) =>
          running ? running(note) : Promise.reject(new Error('No turn is running')),
        salvage: async () => {
          if (!turn) return
          turn.salvaged ??= storedUsage(turn.startedAt)
          await turn.salvaged
        },
        close: () => {
          stopToken()
          return session.destroy().catch(() => {})
        },
      }
    },
  }
}
