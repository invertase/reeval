import { HarnessAgent } from '@ai-sdk/harness/agent'
import { WORKSPACE_DIR } from '@evalsuite/sandbox-docker'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { isDockerSandbox } from '../sandbox/docker.ts'
import { InfraError } from '../sandbox/types.ts'
import type { AgentHarnessDescriptor, TranscriptEvent, TurnStatus } from '../types.ts'
import { AGENTS, agentAuth } from './agents.ts'
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

/** A real agent through its AI SDK harness adapter, in the Docker sandbox's container. */
export function createAgentHarness(descriptor: AgentHarnessDescriptor): Harness {
  const catalog = AGENTS[descriptor.kind]
  return {
    async start(sandbox, signal, { skills, mcp }) {
      const auth = agentAuth(catalog)
      const agent = new HarnessAgent({
        harness: await catalog.adapter({
          auth,
          ...(Object.keys(mcp).length ? { mcpServers: catalog.mcpServers(mcp) } : {}),
        }),
        model: descriptor.model,
        permissionMode: 'allow-all',
        sandboxConfig: { workDir: WORKSPACE_DIR },
        ...(skills.length ? { skills } : {}),
      })
      if (!isDockerSandbox(sandbox)) {
        throw new InfraError(`The ${catalog.name} harness needs the Docker sandbox`)
      }
      let session: Awaited<ReturnType<typeof agent.createSession>>
      try {
        session = await agent.createSession({
          sandboxSession: sandbox.network,
          abortSignal: signal,
        })
      } catch (error) {
        if (signal.aborted) throw error
        throw new InfraError(`${catalog.name} harness failed to start: ${(error as Error).message}`)
      }
      return {
        async send(prompt, turnSignal) {
          const startedAt = Date.now()
          const parts: StampedPart[] = []
          const finish = (text: string, status: TurnStatus, extra: TranscriptEvent[] = []) => ({
            text,
            status,
            startedAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            transcript: [...normaliseStream(parts, startedAt), ...extra],
            ...(process.env.ES_RAW_TRANSCRIPT ? { raw: parts } : {}),
          })
          try {
            // stream(), not generate(): only the stream says when each event happened.
            const result = await agent.stream({ session, prompt, abortSignal: turnSignal })
            const tools = new Map<string, { name: string; at: number }>()
            for await (const part of result.fullStream) {
              const ms = Date.now() - startedAt
              parts.push({ ms, part: part as StampedPart['part'] })
              traceStreamPart(part as StampedPart['part'], ms, tools)
            }
            return finish(await result.text, 'completed')
          } catch (error) {
            const message = errorText(error)
            const at = Date.now() - startedAt
            return finish('', turnSignal.aborted ? 'aborted' : 'error', [
              { type: 'error', message, ts: new Date(startedAt + at).toISOString(), atMs: at },
            ])
          }
        },
        close: () => session.destroy().catch(() => {}),
      }
    },
  }
}
