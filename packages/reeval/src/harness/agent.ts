import type { HarnessV1, HarnessV1Session, HarnessV1StreamPart } from '@ai-sdk/harness'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { WORKSPACE_DIR } from '@reeval/sandbox-docker'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { isDockerSandbox } from '../sandbox/docker.ts'
import { InfraError } from '../sandbox/types.ts'
import type { AgentHarnessDescriptor, TokenUsage, TranscriptEvent, TurnStatus } from '../types.ts'
import { addUsage } from '../usage.ts'
import { agentAuth, agentFor, agentMcp, authHint, writePluginFiles } from './agents.ts'
import { errorText, normaliseStream, type StampedPart } from './transcript.ts'
import type { Harness } from './types.ts'

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

/** The AI SDK's usage as reeval's, or null when the harness reported none (every field undefined). */
export function tokenUsage(usage: {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  inputTokenDetails?: {
    noCacheTokens?: number | undefined
    cacheReadTokens?: number | undefined
    cacheWriteTokens?: number | undefined
  }
  outputTokenDetails?: { reasoningTokens?: number | undefined }
}): TokenUsage | null {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0
  return {
    input:
      usage.inputTokenDetails?.noCacheTokens ??
      Math.max((usage.inputTokens ?? 0) - cacheRead - cacheWrite, 0),
    output: usage.outputTokens ?? 0,
    cacheRead,
    cacheWrite,
    reasoning: usage.outputTokenDetails?.reasoningTokens ?? null,
  }
}

type Usage = Parameters<typeof tokenUsage>[0]

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

/** A real agent through its AI SDK harness adapter, in the Docker sandbox's container. */
export function createAgentHarness(descriptor: AgentHarnessDescriptor): Harness {
  const catalog = agentFor(descriptor)
  return {
    async start(sandbox, signal, { skills, mcp, plugins }) {
      const auth = agentAuth(catalog)
      let servedModel: string | null = null
      let finishMetadata: unknown
      const servers = agentMcp(catalog, mcp, plugins)
      const adapter = await catalog.adapter({
        auth,
        descriptor,
        plugins,
        ...(Object.keys(servers).length ? { mcpServers: catalog.mcpServers(servers) } : {}),
      })
      for (const path of await writePluginFiles(sandbox, catalog, plugins)) {
        debugLog('env', `plugin settings → ${path}`)
      }
      const off = interactiveTools(adapter as HarnessV1)
      const agent = new HarnessAgent({
        harness: observed(adapter as HarnessV1, (part) => {
          if (part.type === 'stream-start' && part.modelId) servedModel = part.modelId
          if (part.type === 'finish') finishMetadata = part.harnessMetadata
        }),
        model: catalog.modelId?.(descriptor.model) ?? descriptor.model,
        permissionMode: 'allow-all',
        ...(off.length ? { inactiveTools: off } : {}),
        sandboxConfig: { workDir: WORKSPACE_DIR },
        ...(skills.length ? { skills } : {}),
      })
      if (!isDockerSandbox(sandbox)) {
        throw new InfraError(
          `The ${catalog.name} harness needs the Docker sandbox: set sandbox: docker() for this eval, or use fakeHarness() with fakeSandbox()`,
        )
      }
      let session: Awaited<ReturnType<typeof agent.createSession>>
      try {
        session = await agent.createSession({
          sandboxSession: sandbox.network,
          abortSignal: signal,
        })
      } catch (error) {
        if (signal.aborted) throw error
        const message = (error as Error).message
        const hint = authHint(catalog, message)
        throw new InfraError(
          `${hint ? `${hint}. ` : ''}${catalog.name} harness failed to start: ${message}`,
        )
      }
      return {
        async send(prompt, turnSignal) {
          const startedAt = Date.now()
          const parts: StampedPart[] = []
          const servedBefore = sandbox.servedRequests?.().length ?? 0
          servedModel = null
          finishMetadata = undefined
          let stepUsage: TokenUsage | null = null
          const finish = (
            text: string,
            status: TurnStatus,
            extra: TranscriptEvent[] = [],
            usage: TokenUsage | null = stepUsage,
          ) => ({
            text,
            status,
            usage,
            // An adapter that doesn't say takes the gateway's word: the turn's last brokered call.
            model: servedModel ?? sandbox.servedRequests?.().slice(servedBefore).at(-1) ?? null,
            unreported: catalog.unreported?.(finishMetadata) ?? [],
            startedAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            transcript: [...normaliseStream(parts, startedAt), ...extra].map((e) => {
              if (e.type !== 'error') return e
              const hint = authHint(catalog, e.message)
              return hint ? { ...e, message: `${hint}. ${e.message}` } : e
            }),
            ...(process.env.REEVAL_RAW_TRANSCRIPT ? { raw: parts } : {}),
          })
          try {
            // stream(), not generate(): only the stream says when each event happened.
            const result = await agent.stream({ session, prompt, abortSignal: turnSignal })
            const tools = new Map<string, { name: string; at: number }>()
            for await (const part of result.fullStream) {
              const ms = Date.now() - startedAt
              parts.push({ ms, part: part as StampedPart['part'] })
              traceStreamPart(part as StampedPart['part'], ms, tools)
              if (part.type === 'finish-step') {
                stepUsage = addUsage(stepUsage, tokenUsage(part.usage as Usage))
              }
            }
            const total = tokenUsage(await result.totalUsage)
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
          }
        },
        close: () => session.destroy().catch(() => {}),
      }
    },
  }
}
