import { setTimeout as sleep } from 'node:timers/promises'
import { skillFiles } from '../environment/resolve.ts'
import { InfraError } from '../sandbox/types.ts'
import type { FakeHarnessDescriptor, TranscriptEvent } from '../types.ts'
import type { Harness } from './types.ts'

const lineCount = (text: string) =>
  text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0

/** Where the Cursor adapter puts harness-placed skills: the ACP agent's `~/.agents/skills`. */
export const FAKE_HARNESS_SKILL_DIR = '~/.agents/skills'

/**
 * Writes canned files and returns a canned message on every turn, after running its `script`'s
 * real sandbox actions. Harness-placed skills are written where the Cursor adapter puts them.
 */
export const createFakeHarness = (descriptor: FakeHarnessDescriptor): Harness => ({
  async start(sandbox, _signal, { skills, workspaceSkills, mcp }) {
    if (descriptor.failWith) throw new InfraError(descriptor.failWith)
    for (const skill of skills) {
      for (const f of skillFiles(skill)) {
        await sandbox.writeFile(`${FAKE_HARNESS_SKILL_DIR}/${skill.name}/${f.path}`, f.content)
      }
    }
    const names = [...skills.map((s) => s.name), ...workspaceSkills]
    const loaded = [
      names.length ? `skills: ${names.join(', ')}` : '',
      Object.keys(mcp).length ? `mcp: ${Object.keys(mcp).join(', ')}` : '',
    ].filter(Boolean)
    let calls = 0
    let turns = 0
    const skilled = names.length > 0 && descriptor.withSkill
    const files = (skilled ? descriptor.withSkill?.files : undefined) ?? descriptor.files ?? {}
    const reply = (skilled ? descriptor.withSkill?.text : undefined) ?? descriptor.text ?? 'Done.'
    const flaked = Math.random() < (descriptor.flakeRate ?? 0)
    return {
      async send(prompt, signal) {
        const startedAt = Date.now()
        const script = descriptor.script ?? []
        const steps = script[Math.min(turns++, script.length - 1)] ?? []
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
        const write = async (path: string, content: string) => {
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
        let scripted: string | undefined
        for (const step of steps) {
          if ('exec' in step) {
            const time = at()
            const r = await sandbox.exec(step.exec, { signal })
            transcript.push({
              ...time,
              type: 'tool',
              toolCallId: `call_${++calls}`,
              tool: 'shell',
              input: { command: step.exec },
              output: r.stdout,
              ok: r.exitCode === 0,
              durationMs: Date.now() - startedAt - time.atMs,
            })
          } else if ('write' in step) {
            for (const [path, content] of Object.entries(step.write)) await write(path, content)
          } else scripted = step.reply
        }
        if (descriptor.delayMs) {
          try {
            await sleep(descriptor.delayMs, undefined, { signal })
          } catch {
            return done('', 'aborted')
          }
        }
        for (const [path, content] of Object.entries(files)) await write(path, content)
        const text = scripted ?? reply
        transcript.push({ ...at(), type: 'text', text, durationMs: 0 })
        return done(text, 'completed')
      },
      async close() {},
    }
  },
})
