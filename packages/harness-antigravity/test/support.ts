import { readFileSync } from 'node:fs'
import type { HarnessV1RequestTransformation, HarnessV1StreamPart } from '@ai-sdk/harness'

export const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** A byte stream; a list of byte arrays arrives as those exact chunks. */
const stream = (content: string | Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const chunks = typeof content === 'string' ? [new TextEncoder().encode(content)] : content
      for (const chunk of chunks) if (chunk.length > 0) controller.enqueue(chunk)
      controller.close()
    },
  })

export type Spawned = { command: string; env: Record<string, string>; workingDirectory?: string }

/** An in-memory sandbox: files in a map, `$HOME` is /root, and each spawn replays a script. */
export function fakeSandbox(options: {
  broker?: boolean
  turns?: Array<{ stdout: string | Uint8Array[]; stderr?: string; exitCode?: number }>
}) {
  const files = new Map<string, string>()
  const spawned: Spawned[] = []
  const transformations: HarnessV1RequestTransformation[] = []
  const turns = [...(options.turns ?? [])]
  const session = {
    description: 'fake',
    files,
    spawned,
    transformations,
    async readTextFile({ path }: { path: string }) {
      return files.get(path) ?? null
    },
    async readFile({ path }: { path: string }) {
      const content = files.get(path)
      return content === undefined ? null : stream(content)
    },
    async readBinaryFile({ path }: { path: string }) {
      const content = files.get(path)
      return content === undefined ? null : new TextEncoder().encode(content)
    },
    async writeTextFile({ path, content }: { path: string; content: string }) {
      files.set(path, content)
    },
    async writeBinaryFile({ path, content }: { path: string; content: Uint8Array }) {
      files.set(path, new TextDecoder().decode(content))
    },
    async writeFile() {
      throw new Error('not used')
    },
    async run({ command }: { command: string }) {
      const ok = { exitCode: 0, stdout: '', stderr: '' }
      if (command.includes('$HOME')) return { ...ok, stdout: '/root' }
      const quoted = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '')
      if (command.startsWith('mv -f ')) {
        const [from = '', to = ''] = quoted
        const content = files.get(from)
        if (content !== undefined) files.set(to, content)
        files.delete(from)
      } else if (command.startsWith('rm ')) {
        for (const target of quoted) {
          for (const key of [...files.keys()]) {
            if (key === target || key.startsWith(`${target}/`)) files.delete(key)
          }
        }
      } else if (command.startsWith('test ! -e ')) {
        const target = quoted[0] ?? ''
        const exists = [...files.keys()].some((k) => k === target || k.startsWith(`${target}/`))
        return { ...ok, exitCode: exists ? 1 : 0 }
      }
      return ok
    },
    async spawn(o: { command: string; env?: Record<string, string>; workingDirectory?: string }) {
      spawned.push({
        command: o.command,
        env: o.env ?? {},
        ...(o.workingDirectory ? { workingDirectory: o.workingDirectory } : {}),
      })
      const turn = turns.shift() ?? { stdout: '' }
      return {
        stdout: stream(turn.stdout),
        stderr: stream(turn.stderr ?? ''),
        wait: async () => ({ exitCode: turn.exitCode ?? 0 }),
        kill: async () => {},
      }
    },
    ...(options.broker === false
      ? {}
      : {
          async addRequestTransformations(rules: readonly HarnessV1RequestTransformation[]) {
            transformations.push(...rules)
          },
        }),
  }
  return session
}

/** Runs one prompt turn to completion and returns every part it emitted. */
export async function runTurn(
  session: {
    doPromptTurn(o: unknown): PromiseLike<{ done: PromiseLike<void> }>
  },
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<HarnessV1StreamPart[]> {
  const parts: HarnessV1StreamPart[] = []
  const control = await session.doPromptTurn({
    prompt,
    skills: [],
    tools: [],
    emit: (p: HarnessV1StreamPart) => parts.push(p),
    ...extra,
  })
  await control.done
  return parts
}

/** Parts without the raw passthrough, for readable assertions. */
export const visible = (parts: HarnessV1StreamPart[]) => parts.filter((p) => p.type !== 'raw')
