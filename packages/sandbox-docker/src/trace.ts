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
const asIs = (text: string) => text
let mask = asIs

/**
 * Calls `fn` for every docker command this process runs, or stops with `undefined`. `redact`
 * masks each argument, stream and error before it's clipped, so a value the clip would cut
 * through is masked whole.
 */
export function onDockerCommand(
  fn: Listener | undefined,
  redact: (text: string) => string = asIs,
): void {
  listener = fn
  mask = redact
}

/**
 * How far past the clip `redact` reads, so a value that starts before the clip and is shorter
 * than this is masked whole, without masking all of a large output.
 */
const MASK_SPAN = 16 * 1024

const clip = (raw: string, max: number) => {
  const read = raw.slice(0, max + MASK_SPAN)
  const text = mask(read)
  const unread = raw.length - read.length
  if (text.length <= max && !unread) return text
  return `${text.slice(0, max)}… (${Math.max(0, text.length - max) + unread} more)`
}

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
      listener({ ...base, exitCode: null, stdout: '', stderr: '', error: mask(error) })
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
