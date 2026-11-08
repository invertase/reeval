import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { docker } from '../docker-cli.ts'
import type { Engine } from '../engine.ts'
import { type RunResult, run, shellQuote } from '../process.ts'
import { engineLabel, hostCommand } from '../remote-engine.ts'
import { traceDocker } from '../trace.ts'

/** How a host command ended, as a debug trace records it. */
export type ExecEnd = Parameters<typeof traceDocker>[2]

/**
 * How the egress gateway runs a process inside a sandbox, with its stdin, stdout and stderr piped
 * to this process: `docker exec -i` for a container, `tart exec -i` or `ssh -T` for a VM.
 *
 * The process runs as root, whoever the sandbox runs as: the sandbox user can't signal, trace or
 * replace the forwarder, or change the CA the gateway installed.
 */
export type ExecTransport = {
  /** The host argv, program first, that runs `command` in the sandbox as root with stdin open. */
  argv(command: readonly string[]): string[]
  /** Variables the host program runs with, over this process's. Never credentials in `argv`. */
  env?: Record<string, string>
  /** Runs `command` to its end with `input` on stdin; running `argv(command)` unless set. */
  run?(
    command: readonly string[],
    options: { input: string; signal?: AbortSignal },
  ): Promise<RunResult<Buffer>>
  /** Called as each host command this transport started ends, for debug traces. */
  trace?(argv: readonly string[], startedAt: number, end: ExecEnd): void
  /**
   * Killing the host program can leave its process running in the sandbox, where the sandbox
   * outlives it (`tart exec`, `ssh`), so the gateway stops its forwarder there itself: any left
   * from an earlier gateway before it starts one, and its own when it closes. A container's
   * forwarder goes with the container.
   */
  orphans?: boolean
}

/** Runs `command` in the sandbox to its end. */
export async function execRun(
  transport: ExecTransport,
  command: readonly string[],
  options: { input: string; signal?: AbortSignal },
): Promise<RunResult<Buffer>> {
  if (transport.run) return transport.run(command, options)
  const [bin = '', ...args] = transport.argv(command)
  const startedAt = Date.now()
  try {
    const r = await run(bin, args, { ...options, env: transport.env, binary: true })
    transport.trace?.([bin, ...args], startedAt, { ...r, stdin: options.input.length })
    return r
  } catch (error) {
    transport.trace?.([bin, ...args], startedAt, { error })
    throw error
  }
}

/** Starts `command` in the sandbox and leaves it running, its stdio piped. */
export function execSpawn(
  transport: ExecTransport,
  command: readonly string[],
): ChildProcessWithoutNullStreams {
  const argv = transport.argv(command)
  const [bin = '', ...args] = argv
  const startedAt = Date.now()
  // Own process group, like every docker call: reeval handles Ctrl-C and tears the gateway down.
  const child = spawn(bin, args, {
    stdio: 'pipe',
    detached: true,
    env: { ...process.env, ...transport.env },
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  child.once('close', (code) => transport.trace?.(argv, startedAt, { exitCode: code, stderr }))
  return child
}

/** What every `ssh` reeval runs passes: no prompt, a dropped connection noticed within a minute. */
export const SSH_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
  '-o',
  'LogLevel=ERROR',
] as const

/**
 * Whether `dir` is a directory only this user can enter, made (0700) first with `make`. An ssh
 * client trusts whatever listens at its ControlPath, so a socket in a directory another user can
 * write lets them stand in for the host.
 */
export function privateDir(dir: string, o: { make?: boolean } = {}): boolean {
  try {
    if (o.make) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    return st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0
  } catch {
    return false
  }
}

/**
 * Whether ssh can listen on a control socket at `path` on `platform`. A socket's path has
 * `sizeof(sun_path)` bytes with its NUL (104 on macOS and the BSDs, 108 on Linux), and the master
 * first listens on `path` plus a 17-byte random suffix. `%C` expands to a 40-character hash.
 */
export function controlPathFits(path: string, platform: NodeJS.Platform = process.platform) {
  const room = platform === 'linux' ? 108 : 104
  return Buffer.byteLength(path.replaceAll('%C', 'C'.repeat(40))) + 17 < room
}

/**
 * The options that share one connection through a control socket at `path`, kept open `persistS`
 * seconds after the last command; none on Windows, whose OpenSSH has no ControlMaster, when the
 * path is too long for a socket ({@link controlPathFits}), or when the socket's directory isn't
 * {@link privateDir}. `path` may end in an ssh token such as `%C`.
 */
export function controlOptions(path: string | undefined, persistS: number): string[] {
  if (!path || process.platform === 'win32' || !controlPathFits(path)) return []
  if (!privateDir(dirname(path))) return []
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${path}`,
    '-o',
    `ControlPersist=${persistS}`,
  ]
}

/** A VM reached over SSH with a per-sandbox key and a pinned host key. */
export type SshTarget = {
  host: string
  port: number
  /** The login user, who has passwordless `sudo` unless {@link SshTarget.loginRoot}. */
  user: string
  /**
   * The login user is root, as in an image with no `sudo` (a `daytona()` image): root's commands
   * run as it, and the sandbox user's through `setpriv`.
   */
  loginRoot?: boolean
  /** The private key `ssh -i` takes. */
  identityFile: string
  /** A known_hosts file whose one line names {@link hostKeyAlias}. */
  knownHostsFile: string
  /** The name the host key is pinned under, since several VMs share one NAT host. */
  hostKeyAlias: string
  /**
   * Where the connection's control socket lives, so every command shares one connection: in a
   * directory only this user can enter, or the commands don't share one.
   */
  controlPath?: string
}

/**
 * The host argv that runs `remote`, one shell command line, on `target`. ssh joins its remote
 * arguments into one line for the login shell, so the caller quotes it. No user config applies.
 */
export function sshArgv(target: SshTarget, remote: string): string[] {
  return [
    'ssh',
    '-T',
    '-F',
    'none',
    '-i',
    target.identityFile,
    '-p',
    String(target.port),
    ...SSH_OPTIONS,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${target.knownHostsFile}`,
    '-o',
    'GlobalKnownHostsFile=none',
    '-o',
    `HostKeyAlias=${target.hostKeyAlias}`,
    '-o',
    'ConnectTimeout=20',
    ...controlOptions(target.controlPath, 300),
    `${target.user}@${target.host}`,
    remote,
  ]
}

/** How a command line on `target` runs as root: through `sudo -n`, unless it logs in as root. */
export const asRootPrefix = (target: Pick<SshTarget, 'loginRoot'>) =>
  target.loginRoot ? '' : 'sudo -n -- '

/** `ssh -T` into a VM, as root through `sudo -n` (with sudo's own `secure_path`) or as its login. */
export function sshTransport(target: SshTarget): ExecTransport {
  return {
    argv: (command) =>
      sshArgv(target, `${asRootPrefix(target)}${command.map(shellQuote).join(' ')}`),
    trace: (argv, startedAt, end) => traceDocker(argv.slice(1), startedAt, end, 'ssh'),
  }
}

/** `docker exec` (or `podman exec`) into a running container, as root. */
export function containerTransport(containerId: string, engine?: Engine): ExecTransport {
  const sent = new WeakMap<readonly string[], readonly string[]>()
  const exec = (command: readonly string[]) => [
    'exec',
    '--interactive',
    '--user',
    '0:0',
    containerId,
    ...command,
  ]
  return {
    argv: (command) => {
      const host = hostCommand(engine, exec(command))
      const argv = [host.bin, ...host.args]
      sent.set(argv, exec(command))
      return argv
    },
    env: hostCommand(engine, []).env,
    run: (command, { input, signal }) => docker(exec(command), { input, signal, engine }),
    trace: (argv, startedAt, end) =>
      traceDocker(sent.get(argv) ?? argv.slice(1), startedAt, end, engineLabel(engine)),
  }
}
