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

type Script = {
  stdout: string | Uint8Array[]
  stderr?: string
  exitCode?: number
  /** The runner exits after this turn, so the next one needs a new process. */
  exit?: boolean
}

/**
 * An in-memory sandbox: files in a map, `$HOME` is /root. A spawned runner replays the next turn's
 * script each time that turn's `.ready` file appears, and lives until a script with `exit` (or
 * the last one) ends.
 */
export function fakeSandbox(options: { broker?: boolean; turns?: Script[] }) {
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
      const [, dir = '', first = '1'] = o.command.match(/' '([^']+)' (\d+)$/) ?? []
      let n = Number(first)
      let last: Script | undefined
      let killed = false
      let stderr!: ReadableStreamDefaultController<Uint8Array>
      let exit!: () => void
      const exited = new Promise<void>((r) => {
        exit = r
      })
      const encode = (text: string) => new TextEncoder().encode(text)
      const stdout = new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (!killed && !files.has(`${dir}/turn-${n}.ready`)) {
            await new Promise((r) => setTimeout(r, 1))
          }
          const script = killed ? undefined : turns.shift()
          if (script) {
            last = script
            n++
            const chunks =
              typeof script.stdout === 'string' ? [encode(script.stdout)] : script.stdout
            for (const chunk of chunks) if (chunk.length > 0) controller.enqueue(chunk)
            if (script.stderr) stderr.enqueue(encode(script.stderr))
          }
          if (!script || script.exit || turns.length === 0) {
            controller.close()
            stderr.close()
            exit()
          }
        },
      })
      return {
        stdout,
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            stderr = controller
          },
        }),
        wait: async () => {
          await exited
          return { exitCode: last?.exitCode ?? 0 }
        },
        kill: async () => {
          killed = true
        },
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
