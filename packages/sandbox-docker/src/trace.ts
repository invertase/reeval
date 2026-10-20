import { isUtf8 } from 'node:buffer'

/** One docker (or podman) CLI invocation, for debug traces. Values passed through `env` never appear here. */
export type DockerCommand = {
  /** The CLI: `docker` or `podman`. */
  bin: string
  args: string[]
  /** Null when the command was killed or failed to start. */
  exitCode: number | null
  ms: number
  stdout: string
  stderr: string
  /** Bytes sent on stdin, when there were any. */
  stdin?: number
  error?: string
}

/** Most of each stream a trace keeps; the rest is counted. */
const MAX_STREAM = 4096
/** Most of each argument a trace keeps, e.g. the gateway's forwarder script. */
const MAX_ARG = 300

type Listener = (command: DockerCommand) => void
let listener: Listener | undefined

/** Calls `fn` for every docker command this process runs, or stops with `undefined`. */
export function onDockerCommand(fn: Listener | undefined): void {
  listener = fn
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… (${text.length - max} more)` : text

/** Text as is (clipped), or a byte count for binary output such as a file read with `cat`. */
export function streamPreview(data: Buffer | string): string {
  if (typeof data === 'string') return clip(data, MAX_STREAM)
  if (data.includes(0) || !isUtf8(data)) return `<${data.length} bytes>`
  return clip(data.toString('utf8'), MAX_STREAM)
}

export function traceDocker(
  args: readonly string[],
  startedAt: number,
  result:
    | { exitCode: number | null; stdout?: Buffer | string; stderr?: string; stdin?: number }
    | { error: unknown },
  bin = 'docker',
): void {
  if (!listener) return
  const base = { bin, args: args.map((a) => clip(a, MAX_ARG)), ms: Date.now() - startedAt }
  try {
    if ('error' in result) {
      const error = result.error instanceof Error ? result.error.message : String(result.error)
      listener({ ...base, exitCode: null, stdout: '', stderr: '', error })
      return
    }
    listener({
      ...base,
      exitCode: result.exitCode,
      stdout: result.stdout === undefined ? '' : streamPreview(result.stdout),
      stderr: clip(result.stderr ?? '', MAX_STREAM),
      ...(result.stdin ? { stdin: result.stdin } : {}),
    })
  } catch {}
}
