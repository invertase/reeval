import { setTimeout as sleep } from 'node:timers/promises'
import { InfraError } from '../sandbox/types.ts'
import type { FakeHarnessDescriptor, TranscriptEvent } from '../types.ts'
import type { Harness } from './types.ts'

const lineCount = (text: string) =>
  text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0

/** Writes canned files into the sandbox and returns a canned message on every turn. */
export const createFakeHarness = (descriptor: FakeHarnessDescriptor): Harness => ({
  async start(sandbox, _signal, { skills, mcp }) {
    if (descriptor.failWith) throw new InfraError(descriptor.failWith)
    const loaded = [
      skills.length ? `skills: ${skills.map((s) => s.name).join(', ')}` : '',
      Object.keys(mcp).length ? `mcp: ${Object.keys(mcp).join(', ')}` : '',
    ].filter(Boolean)
    let calls = 0
    return {
      async send(prompt, signal) {
        const startedAt = Date.now()
        const at = () => {
          const ms = Date.now() - startedAt
          return { ts: new Date(startedAt + ms).toISOString(), atMs: ms }
        }
        const transcript: TranscriptEvent[] = [
          { ...at(), type: 'text', text: `Working on: ${prompt}`, durationMs: 0 },
          ...(loaded.length
            ? [
                {
                  ...at(),
                  type: 'text' as const,
                  text: `Loaded ${loaded.join('; ')}`,
                  durationMs: 0,
                },
              ]
            : []),
        ]
        const done = (text: string, status: 'completed' | 'aborted') => ({
          text,
          status,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          transcript,
        })
        if (descriptor.delayMs) {
          try {
            await sleep(descriptor.delayMs, undefined, { signal })
          } catch {
            return done('', 'aborted')
          }
        }
        for (const [path, content] of Object.entries(descriptor.files ?? {})) {
          const time = at()
          const before = await sandbox.readFile(path)
          await sandbox.writeFile(path, content)
          transcript.push({
            ...time,
            type: 'file-edit',
            toolCallId: `call_${++calls}`,
            path,
            kind: before === null ? 'create' : 'modify',
            added: lineCount(content),
            removed: before === null ? 0 : lineCount(before),
            durationMs: Date.now() - startedAt - time.atMs,
          })
        }
        const text = descriptor.text ?? 'Done.'
        transcript.push({ ...at(), type: 'text', text, durationMs: 0 })
        return done(text, 'completed')
      },
      async close() {},
    }
  },
})
