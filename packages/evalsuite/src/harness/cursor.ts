import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createCursor } from '@ai-sdk/harness-cursor'
import { isDockerSandbox } from '../sandbox/docker.ts'
import { WORKSPACE_DIR } from '../sandbox/image.ts'
import { InfraError } from '../sandbox/types.ts'
import type { CursorHarnessDescriptor, TranscriptEvent, TurnStatus } from '../types.ts'
import { normaliseStream, type StampedPart } from './transcript.ts'
import type { Harness } from './types.ts'

export function createCursorHarness(descriptor: CursorHarnessDescriptor): Harness {
  const agent = new HarnessAgent({
    harness: createCursor(),
    model: descriptor.model,
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: WORKSPACE_DIR },
  })

  return {
    async start(sandbox, signal) {
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
