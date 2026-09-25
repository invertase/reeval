import { HarnessAgent } from '@ai-sdk/harness/agent'
import { WORKSPACE_DIR } from '@evalsuite/sandbox-docker'
import { isDockerSandbox } from '../sandbox/docker.ts'
import { InfraError } from '../sandbox/types.ts'
import type { AgentHarnessDescriptor, TranscriptEvent, TurnStatus } from '../types.ts'
import { AGENTS } from './agents.ts'
import { normaliseStream, type StampedPart } from './transcript.ts'
import type { Harness } from './types.ts'

/** A real agent through its AI SDK harness adapter, in the Docker sandbox's container. */
export function createAgentHarness(descriptor: AgentHarnessDescriptor): Harness {
  const agent = AGENTS[descriptor.kind]
  return {
    async start(sandbox, signal, { skills, mcp }) {
      const runner = new HarnessAgent({
        harness: await agent.adapter(
          Object.keys(mcp).length ? { mcpServers: agent.mcpServers(mcp) } : {},
        ),
        model: descriptor.model,
        permissionMode: 'allow-all',
        sandboxConfig: { workDir: WORKSPACE_DIR },
        ...(skills.length ? { skills } : {}),
      })
      if (!isDockerSandbox(sandbox)) {
        throw new InfraError(`The ${agent.name} harness needs the Docker sandbox`)
      }
      let session: Awaited<ReturnType<typeof runner.createSession>>
      try {
        session = await runner.createSession({
          sandboxSession: sandbox.network,
          abortSignal: signal,
        })
      } catch (error) {
        if (signal.aborted) throw error
        throw new InfraError(`${agent.name} harness failed to start: ${(error as Error).message}`)
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
            const result = await runner.stream({ session, prompt, abortSignal: turnSignal })
            for await (const part of result.fullStream) {
              parts.push({ ms: Date.now() - startedAt, part: part as StampedPart['part'] })
            }
            return finish(await result.text, 'completed')
          } catch (error) {
            const message = (error as Error).message
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
