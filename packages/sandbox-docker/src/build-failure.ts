// Why an image build failed, from `docker build --progress plain` output or a bootstrap error:
// the failing step, its own last lines, a named cause, and whether retrying could help.

/** Which part of making a sandbox image failed. */
export type ImageStage = 'image' | 'from' | 'dockerfile' | 'harness' | 'install'

/** A cause ES recognises and names in the headline. */
export type FailureCause = 'enospc' | 'oom'

export type ImageFailure = {
  stage: ImageStage
  /** The image being made (or, for `image`, looked up). */
  ref: string
  /** A registry or network error that may pass; everything else fails the same way again. */
  transient: boolean
  cause: FailureCause | null
  /** The build's full output, when ES wrote one. */
  log: string | null
}

export class ImageBuildError extends Error {
  override name = 'ImageBuildError'
  readonly failure: ImageFailure
  constructor(message: string, failure: ImageFailure) {
    super(message)
    this.failure = failure
  }
}

/** Most of the failing step's own output lines a headline shows. */
export const OUTPUT_LINES = 12

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes.
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

export type ParsedBuild = {
  /** BuildKit's error, without its `ERROR: failed to build: failed to solve:` prefix. */
  error: string | null
  /** The failing step's own output, last lines first cut. */
  output: string[]
  exitCode: number | null
}

/** The failing step and its output from `--progress plain` build output. */
export function parseBuildOutput(text: string): ParsedBuild {
  const lines = stripAnsi(text).split(/\r?\n/)
  let step: string | null = null
  let error: string | null = null
  for (const line of lines) {
    const failed = /^#(\d+) ERROR: /.exec(line)
    if (failed) step = failed[1] ?? null
    const top = /^ERROR: (.*)$/.exec(line)
    if (top) error = top[1] ?? null
  }
  error = (error ?? '').replace(/^(failed to build: )?(failed to solve: )?/, '').trim() || null
  const output = step
    ? lines.flatMap((line) => {
        const m = new RegExp(`^#${step} \\d+\\.\\d+ (.*)$`).exec(line)
        return m?.[1]?.trim() ? [m[1]] : []
      })
    : []
  const code = /exit code: (\d+)/.exec(error ?? '')?.[1]
  return { error, output: output.slice(-OUTPUT_LINES), exitCode: code ? Number(code) : null }
}

/** ENOSPC or a SIGKILL (137, usually the out-of-memory killer), from anything the build printed. */
export function failureCause(text: string, exitCode: number | null): FailureCause | null {
  if (/no space left on device|ENOSPC/i.test(text)) return 'enospc'
  if (exitCode === 137 || /exit(?:ed| code:?) 137\b|signal: killed|OOMKilled/i.test(text)) {
    return 'oom'
  }
  return null
}

export const causeLine = (cause: FailureCause) =>
  cause === 'enospc'
    ? 'out of disk space (ENOSPC): free space for Docker (docker system df, es clean --images) and rerun'
    : 'killed (exit 137): usually out of memory; give Docker more memory or lower the concurrency'

// What a user's step did wrong fails the same way however often it runs.
const DETERMINISTIC =
  /did not complete successfully|dockerfile parse error|unknown instruction|should not be blank|pull access denied|repository does not exist|manifest unknown|not found: manifest|: not found\b|unauthorized|denied:|ES needs a Debian or Ubuntu based image/i
const TRANSIENT =
  /EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|i\/o timeout|TLS handshake timeout|no such host|temporary failure in name resolution|connection reset by peer|dial tcp|net\/http: request canceled|unexpected EOF|\b(?:500|502|503|504) |429 Too Many Requests|toomanyrequests|Service Unavailable|Bad Gateway|Gateway Timeout|ENOTFOUND/i

/** A registry or network error: a pull, a metadata lookup, or a download in the harness bootstrap. */
export const isTransient = (text: string) => !DETERMINISTIC.test(text) && TRANSIENT.test(text)

/** Up to `retries` more tries on a transient failure, after `delays` ms each; any other throws at once. */
export async function retryTransient<T>(
  run: () => Promise<T>,
  options: { signal?: AbortSignal; delays?: number[]; onRetry?: (error: Error) => void } = {},
): Promise<T> {
  const delays = options.delays ?? RETRY_DELAYS
  for (let i = 0; ; i++) {
    try {
      return await run()
    } catch (error) {
      const transient =
        error instanceof ImageBuildError
          ? error.failure.transient
          : isTransient((error as Error).message)
      if (!transient || i >= delays.length || options.signal?.aborted) throw error
      options.onRetry?.(error as Error)
      await new Promise((resolve) => setTimeout(resolve, delays[i]))
    }
  }
}

/** Two more tries, after 2 s and then 8 s. */
export const RETRY_DELAYS = [2_000, 8_000]

/**
 * A failure's text: the headline (what failed and why), the named cause, the step's own last
 * lines, then the log. Never the generated Dockerfile.
 */
export function failureMessage(parts: {
  headline: string
  cause: FailureCause | null
  output: string[]
  log?: string | null
}): string {
  const lines = [parts.headline]
  if (parts.cause) lines.push(causeLine(parts.cause))
  if (parts.output.length) lines.push(...parts.output.map((l) => `  | ${l}`))
  if (parts.log) lines.push(`(full log: ${parts.log})`)
  return lines.join('\n')
}

/** The last lines of a bootstrap command's output, past the error's own first line. */
export function outputTail(text: string, max = OUTPUT_LINES): string[] {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-max)
}
