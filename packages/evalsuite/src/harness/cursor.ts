import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createCursor } from '@ai-sdk/harness-cursor'
import { isDockerSandbox } from '../sandbox/docker.ts'
import { WORKSPACE_DIR } from '../sandbox/image.ts'
import { InfraError } from '../sandbox/types.ts'
import type { CursorHarnessDescriptor, TranscriptEvent } from '../types.ts'
import type { Harness } from './types.ts'

type Part = { type: string }

export function toTranscript(
  steps: ReadonlyArray<{ content: ReadonlyArray<Part> }>,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (const part of steps.flatMap((s) => s.content)) {
    const p = part as Record<string, unknown>
    const toolCallId = String(p.toolCallId ?? '')
    const toolName = String(p.toolName ?? '')
    switch (part.type) {
      case 'text':
        if (typeof p.text === 'string' && p.text) events.push({ type: 'text', text: p.text })
        break
      case 'tool-call':
        events.push({ type: 'tool-call', toolCallId, toolName, input: p.input })
        break
      case 'tool-result':
        events.push({ type: 'tool-result', toolCallId, toolName, output: p.output })
        break
      case 'tool-error':
        events.push({ type: 'error', message: `${toolName}: ${String(p.error)}` })
        break
    }
  }
  return events
}

export function createCursorHarness(descriptor: CursorHarnessDescriptor): Harness {
  const agent = new HarnessAgent({
    harness: createCursor(),
    model: descriptor.model,
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: WORKSPACE_DIR },
  })

  return {
    async run(sandbox, prompt, signal) {
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
      try {
        const result = await agent.generate({ session, prompt, abortSignal: signal })
        return { text: result.text, status: 'completed', transcript: toTranscript(result.steps) }
      } catch (error) {
        const message = (error as Error).message
        return {
          text: '',
          status: signal.aborted ? 'aborted' : 'error',
          transcript: [{ type: 'error', message }],
        }
      } finally {
        await session.destroy().catch(() => {})
      }
    },
  }
}
