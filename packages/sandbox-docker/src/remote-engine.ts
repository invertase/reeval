import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { contextFiles } from './dockerignore.ts'
import { sshArgv } from './egress/transport.ts'
import { type Engine, engineEnv, engineSpec, isRemoteEngine } from './engine.ts'
import { shellQuote as q } from './process.ts'
import { type TarEntry, writeTar } from './tarball.ts'

/** How a command on an engine runs on this machine. */
export type EngineCommand = {
  bin: string
  args: string[]
  /** Merged over `process.env` for the host process. */
  env: Record<string, string>
  /** Written to the process's stdin before anything else: the remote environment. */
  preamble: Buffer | null
}

/**
 * The remote side of a command with an environment: its first stdin line is the base64 of the
 * `export`s, which `read` takes a byte at a time (stdin is a pipe), so the rest of stdin is the
 * CLI's own.
 */
const WITH_ENV =
  'IFS= read -r reeval_env || exit 125; eval "$(printf %s "$reeval_env" | base64 -d)" || exit 125; unset reeval_env; exec "$@"'

/**
 * How to run the engine's CLI with `args`: the CLI itself here, or ssh to it on a remote engine.
 * `env` reaches the CLI's environment, never argv: on a remote engine it's the {@link
 * EngineCommand.preamble}.
 */
export function hostCommand(
  engine: Engine | undefined,
  args: readonly string[],
  env: Record<string, string> = {},
): EngineCommand {
  if (!isRemoteEngine(engine)) {
    return {
      bin: engineSpec(engine).bin,
      args: [...args],
      env: { ...engineEnv(engine), ...env },
      preamble: null,
    }
  }
  const docker = ['docker', ...args].map(q).join(' ')
  const names = Object.keys(env)
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${name} isn't a variable name`)
  }
  const remote = names.length ? `sh -c ${q(WITH_ENV)} sh ${docker}` : `exec ${docker}`
  const [bin = 'ssh', ...rest] = sshArgv(engine.target, remote)
  const exports = names.map((name) => `export ${name}=${q(env[name] ?? '')}`).join('\n')
  return {
    bin,
    args: rest,
    env: {},
    preamble: names.length ? Buffer.from(`${Buffer.from(exports).toString('base64')}\n`) : null,
  }
}

/**
 * Spawns the engine's CLI with `args` in its own process group, its output piped and no stdin of
 * its own; on a remote engine stdin carries only the environment.
 */
export function spawnEngine(
  engine: Engine | undefined,
  args: readonly string[],
  env: Record<string, string> = {},
): ChildProcessByStdio<null, Readable, Readable> {
  const command = hostCommand(engine, args, env)
  const child = spawn(command.bin, command.args, {
    stdio: [command.preamble ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, ...command.env },
  })
  if (command.preamble && child.stdin) {
    child.stdin.on('error', () => {})
    child.stdin.end(command.preamble)
  }
  return child as unknown as ChildProcessByStdio<null, Readable, Readable>
}

/**
 * ssh failing to connect, so the remote CLI never ran and running it again is safe. A connection
 * that drops later isn't one: the command may have run.
 */
export const isSshFailure = (r: { exitCode: number | null; stderr: string }) =>
  r.exitCode === 255 &&
  /^(ssh: connect to host |kex_exchange_identification: |ssh_exchange_identification: |Connection timed out during banner exchange|mux_client_request_session: )/m.test(
    r.stderr,
  )

/** Option flags of `docker build` that take a value as the next argument. */
const BUILD_VALUE_FLAGS = new Set([
  '--add-host',
  '--allow',
  '--annotation',
  '--attest',
  '--build-arg',
  '--build-context',
  '--builder',
  '--cache-from',
  '--cache-to',
  '--call',
  '--cgroup-parent',
  '--file',
  '-f',
  '--iidfile',
  '--label',
  '--load',
  '--metadata-file',
  '--network',
  '--no-cache-filter',
  '--output',
  '-o',
  '--platform',
  '--progress',
  '--provenance',
  '--sbom',
  '--secret',
  '--shm-size',
  '--ssh',
  '--tag',
  '-t',
  '--target',
  '--ulimit',
])

const STDIN_DOCKERFILE = '.reeval-stdin.Dockerfile'

function contextEntries(context: string, files: readonly string[]): TarEntry[] {
  const entries: TarEntry[] = []
  for (const path of files) {
    const full = join(context, path)
    const stat = lstatSync(full, { throwIfNoEntry: false })
    if (!stat) continue
    const mtime = Math.floor(stat.mtimeMs / 1000)
    const mode = stat.mode & 0o7777
    if (stat.isSymbolicLink()) {
      entries.push({ type: 'symlink', path, mode, mtime, target: readlinkSync(full) })
    } else if (stat.isFile()) {
      entries.push({ type: 'file', path, mode, mtime, data: readFileSync(full) })
    }
  }
  return entries
}

/**
 * `docker build` arguments and input for a remote engine: a build context on this machine goes as
 * a tar on stdin (`-`), with its `.dockerignore` rules applied by the builder as they would be
 * here. The Dockerfile keeps its path in the context; one outside it, or one read from stdin,
 * goes in the tar under a name of its own. Directories go only as the files' parents, so an
 * empty one isn't sent. Any other command, and a build whose context is already stdin, is as is.
 */
export function remoteBuild(
  args: readonly string[],
  input: Uint8Array | string | undefined,
): { args: string[]; input: Uint8Array | string | undefined } {
  if (args[0] !== 'build') return { args: [...args], input }
  let file: { at: number; value: string } | null = null
  let contextAt = -1
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] as string
    if (BUILD_VALUE_FLAGS.has(arg)) {
      if (arg === '--file' || arg === '-f') file = { at: i + 1, value: args[i + 1] ?? '' }
      i++
    } else if (arg.startsWith('--file=')) {
      file = { at: i, value: arg.slice('--file='.length) }
    } else if (!arg.startsWith('-') || arg === '-') {
      contextAt = i
    }
  }
  const context = contextAt === -1 ? null : (args[contextAt] as string)
  if (context === null || context === '-') return { args: [...args], input }
  const root = resolve(context)
  const out = [...args]
  out[contextAt] = '-'
  const setFile = (value: string) => {
    if (!file) out.splice(contextAt, 0, '--file', value)
    else if (out[file.at]?.startsWith('--file=')) out[file.at] = `--file=${value}`
    else out[file.at] = value
  }
  const extra: TarEntry[] = []
  const now = Math.floor(Date.now() / 1000)
  let dockerfile: string | null = null
  if (file?.value === '-') {
    const data = Buffer.from(input ?? '')
    extra.push({ type: 'file', path: STDIN_DOCKERFILE, mode: 0o644, mtime: now, data })
    setFile(STDIN_DOCKERFILE)
  } else {
    // The CLI reads `--file` from where it runs, not from the context.
    dockerfile = file ? resolve(file.value) : join(root, 'Dockerfile')
    const inside = relative(root, dockerfile)
    if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
      if (file) setFile(inside.split(sep).join('/'))
    } else {
      const name = `.reeval-${createHash('sha256').update(dockerfile).digest('hex').slice(0, 12)}.Dockerfile`
      extra.push({
        type: 'file',
        path: name,
        mode: 0o644,
        mtime: now,
        data: readFileSync(dockerfile),
      })
      const ignore = lstatSync(`${dockerfile}.dockerignore`, { throwIfNoEntry: false })
      if (ignore?.isFile()) {
        const data = readFileSync(`${dockerfile}.dockerignore`)
        extra.push({ type: 'file', path: `${name}.dockerignore`, mode: 0o644, mtime: now, data })
      }
      setFile(name)
      dockerfile = null
    }
  }
  const files = contextFiles(root, dockerfile).filter((path) => !extra.some((e) => e.path === path))
  return { args: out, input: writeTar([...contextEntries(root, files), ...extra]) }
}
