import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

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

// cmd.exe's metacharacters, and the escaping of them cross-spawn uses.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

const cmdEscape = (arg: string, twice: boolean) => {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(
    CMD_META,
    '^$1',
  )
  return twice ? quoted.replace(CMD_META, '^$1') : quoted
}

/**
 * How to spawn `cmd` on Windows, where npm, npx and pnpm are `.cmd` scripts that only cmd.exe
 * runs: the program PATH and PATHEXT find, and for a script, cmd.exe with every argument escaped.
 */
export function windowsSpawn(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): { file: string; args: string[]; verbatim: boolean } {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const dirs = /[\\/]/.test(cmd) ? [''] : (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)
  const candidates = dirs.flatMap((dir) => {
    const base = dir ? win32.join(dir, cmd) : cmd
    return [...(win32.extname(cmd) ? [base] : []), ...exts.map((ext) => base + ext.toLowerCase())]
  })
  const file = candidates.find(exists) ?? cmd
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args, verbatim: false }
  // A node_modules/.bin shim passes its arguments through cmd.exe a second time.
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
  const line = [
    win32.normalize(file).replace(CMD_META, '^$1'),
    ...args.map((a) => cmdEscape(a, twice)),
  ].join(' ')
  return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/**
 * Kills a process and everything it started: its process group on POSIX (a detached child leads
 * one), its process tree with `taskkill` on Windows, which has neither groups nor signals.
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => {},
    )
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

/** `s` as one single-quoted POSIX shell word. */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

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
    const detached = options.detached ?? true
    const target =
      process.platform === 'win32'
        ? windowsSpawn(cmd, args, options.env ? { ...process.env, ...options.env } : process.env)
        : { file: cmd, args, verbatim: false }
    const child = spawn(target.file, target.args, {
      cwd: options.cwd,
      stdio: 'pipe',
      detached,
      windowsHide: true,
      windowsVerbatimArguments: target.verbatim,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d) => {
      stderr += d
    })
    // A detached child leads its own process group: kill the group, or grandchildren (a `git`
    // under `sh -c`) outlive the abort.
    const onAbort = () => {
      if (detached && child.pid) killTree(child.pid)
      else child.kill('SIGKILL')
    }
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
