import { setTimeout as sleep } from 'node:timers/promises'
import { InfraError } from '../sandbox/types.ts'
import type { FakeHarnessDescriptor, TranscriptEvent } from '../types.ts'
import type { Harness } from './types.ts'

/** Writes canned files into the sandbox and returns a canned message on every turn. */
export const createFakeHarness = (descriptor: FakeHarnessDescriptor): Harness => ({
  async start(sandbox) {
    if (descriptor.failWith) throw new InfraError(descriptor.failWith)
    return {
      async send(prompt, signal) {
        const transcript: TranscriptEvent[] = [{ type: 'text', text: `Working on: ${prompt}` }]
        if (descriptor.delayMs) {
          try {
            await sleep(descriptor.delayMs, undefined, { signal })
          } catch {
            return { text: '', status: 'aborted', transcript }
          }
        }
        for (const [path, content] of Object.entries(descriptor.files ?? {})) {
          const toolCallId = `call_${transcript.length}`
          transcript.push({ type: 'tool-call', toolCallId, toolName: 'write', input: { path } })
          await sandbox.writeFile(path, content)
          transcript.push({ type: 'tool-result', toolCallId, toolName: 'write', output: 'ok' })
        }
        const text = descriptor.text ?? 'Done.'
        transcript.push({ type: 'text', text })
        return { text, status: 'completed', transcript }
      },
      async close() {},
    }
  },
})
