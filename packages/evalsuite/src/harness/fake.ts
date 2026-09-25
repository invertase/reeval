import { setTimeout as sleep } from 'node:timers/promises'
import { InfraError } from '../sandbox/types.ts'
import type { FakeHarnessDescriptor, TranscriptEvent } from '../types.ts'
import type { Harness } from './types.ts'

const lineCount = (text: string) =>
  text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0

/** Writes canned files into the sandbox and returns a canned message on every turn. */
export const createFakeHarness = (descriptor: FakeHarnessDescriptor): Harness => ({
  async start(sandbox, _signal, { skills, workspaceSkills, mcp }) {
    if (descriptor.failWith) throw new InfraError(descriptor.failWith)
    const names = [...skills.map((s) => s.name), ...workspaceSkills]
    const loaded = [
      names.length ? `skills: ${names.join(', ')}` : '',
      Object.keys(mcp).length ? `mcp: ${Object.keys(mcp).join(', ')}` : '',
    ].filter(Boolean)
    let calls = 0
    const skilled = names.length > 0 && descriptor.withSkill
    const files = (skilled ? descriptor.withSkill?.files : undefined) ?? descriptor.files ?? {}
    const reply = (skilled ? descriptor.withSkill?.text : undefined) ?? descriptor.text ?? 'Done.'
    const flaked = Math.random() < (descriptor.flakeRate ?? 0)
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
        if (descriptor.reasoning) {
          transcript.push({ ...at(), type: 'reasoning', text: descriptor.reasoning, durationMs: 0 })
        }
        for (const tool of descriptor.tools ?? []) {
          transcript.push({
            ...at(),
            type: 'tool',
            toolCallId: `call_${++calls}`,
            tool: tool.tool,
            input: tool.input,
            output: tool.output,
            ok: tool.ok ?? true,
            durationMs: 0,
          })
        }
        if (flaked) {
          const text = 'I ran out of ideas and left the workspace unchanged.'
          transcript.push({ ...at(), type: 'text', text, durationMs: 0 })
          return done(text, 'completed')
        }
        if (descriptor.delayMs) {
          try {
            await sleep(descriptor.delayMs, undefined, { signal })
          } catch {
            return done('', 'aborted')
          }
        }
        for (const [path, content] of Object.entries(files)) {
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
        transcript.push({ ...at(), type: 'text', text: reply, durationMs: 0 })
        return done(reply, 'completed')
      },
      async close() {},
    }
  },
})
