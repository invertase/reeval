import { spawn } from 'node:child_process'

export type RunOptions = {
  cwd?: string
  /** Merged over `process.env`. Pass credentials here, never in `args`. */
  env?: NodeJS.ProcessEnv
  input?: string | Uint8Array
  /** Aborting kills the child with SIGKILL and rejects with the signal's reason. */
  signal?: AbortSignal
  /** Own process group (the default): Ctrl-C goes to ES, which then aborts and kills the child. */
  detached?: boolean
  /** Collect stdout as a Buffer rather than a UTF-8 string. */
  binary?: boolean
  onSpawn?: (pid: number) => void
}

export type RunResult<Stdout = string> = { exitCode: number; stdout: Stdout; stderr: string }

/** Spawns a process without a shell and collects its output. */
export function run(
  cmd: string,
  args: string[],
  options: RunOptions & { binary: true },
): Promise<RunResult<Buffer>>
export function run(cmd: string, args: string[], options?: RunOptions): Promise<RunResult>
export function run(
  cmd: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult<Buffer | string>> {
  const { signal } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: 'pipe',
      detached: options.detached ?? true,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d) => {
      stderr += d
    })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(signal.reason)
      const stdout = Buffer.concat(out)
      resolve({ exitCode: code ?? 1, stdout: options.binary ? stdout : stdout.toString(), stderr })
    })
    if (child.pid) options.onSpawn?.(child.pid)
    // The child may exit before reading its stdin.
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}
