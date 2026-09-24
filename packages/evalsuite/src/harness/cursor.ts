import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createCursor } from '@ai-sdk/harness-cursor'
import { WORKSPACE_DIR } from '@evalsuite/sandbox-docker'
import { isDockerSandbox } from '../sandbox/docker.ts'
import { InfraError } from '../sandbox/types.ts'
import type { CursorHarnessDescriptor, McpServer, TranscriptEvent, TurnStatus } from '../types.ts'
import { normaliseStream, type StampedPart } from './transcript.ts'
import type { Harness } from './types.ts'

const pairs = (values: Record<string, unknown> = {}) =>
  Object.entries(values).map(([name, value]) => ({ name, value: String(value) }))

/** ES's MCP servers in the ACP `session/new` shape the Cursor adapter forwards as is. */
export function acpMcpServers(servers: Record<string, McpServer>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      'url' in s
        ? [name, { type: 'http', url: s.url, headers: pairs(s.headers) }]
        : [name, { command: s.command, args: s.args ?? [], env: pairs(s.env) }],
    ),
  )
}

export function createCursorHarness(descriptor: CursorHarnessDescriptor): Harness {
  return {
    async start(sandbox, signal, { skills, mcp }) {
      const agent = new HarnessAgent({
        harness: createCursor(Object.keys(mcp).length ? { mcpServers: acpMcpServers(mcp) } : {}),
        model: descriptor.model,
        permissionMode: 'allow-all',
        sandboxConfig: { workDir: WORKSPACE_DIR },
        ...(skills.length ? { skills } : {}),
      })
      if (!isDockerSandbox(sandbox)) {
        throw new InfraError('The Cursor harness needs the Docker sandbox')
      }
      let session: Awaited<ReturnType<typeof agent.createSession>>
      try {
        session = await agent.createSession({
          sandboxSession: sandbox.network,
          abortSignal: signal,
        })
      } catch (error) {
        if (signal.aborted) throw error
        throw new InfraError(`Cursor harness failed to start: ${(error as Error).message}`)
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
