// The Tart sandbox: one macOS VM per attempt, cloned from the image, booted headless, reached
// over `tart exec` (or SSH) and deleted when the attempt ends.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { type ExecTransport, type Gateway, startGateway } from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import { attemptDebug } from '../debug/attempt.ts'
import { untraced } from '../debug/docker.ts'
import { gatewayPolicy } from '../egress.ts'
import type { TartSandboxDescriptor } from '../types.ts'
import type { SandboxOptions } from './index.ts'
import { tartCli, tartNames, tartOk, tracedRun } from './tart-cli.ts'
import { InfraError, type Sandbox } from './types.ts'

/** How long a clone has to boot until a command runs in it. */
const BOOT_TIMEOUT_MS = 180_000
/**
 * How long one boot probe waits: `tart exec` blocks, about 30s without the Guest Agent, until the
 * agent answers. With an SSH key, `tart exec` gets less, so SSH is tried soon.
 */
export const PROBE_TIMEOUT_MS = 15_000
export const EXEC_PROBE_WITH_SSH_MS = 5_000
/** The user an SSH image is reached as when `ssh.user` is unset: Cirrus Labs' images'. */
export const DEFAULT_SSH_USER = 'admin'
/** Before the image's own PATH in every command, so Homebrew's tools (Node among them) are found. */
export const GUEST_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin'
const SSH_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'LogLevel=ERROR',
  '-T',
]
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const

/** The prefix of every VM a run clones, so a canceled run's VMs can be found and deleted. */
export const vmPrefix = (runId: string) => `reeval-${runId}-`

/** `tart set --memory` takes megabytes; `memory` is bytes, or a number with `b`, `k`, `m` or `g`. */
export function memoryMb(memory: string | number): number {
  if (typeof memory === 'number') return Math.max(1, Math.round(memory / UNITS.m))
  const m = /^(\d+(?:\.\d+)?)([bkmg])?$/i.exec(memory.trim())
  const unit = (m?.[2]?.toLowerCase() ?? 'b') as keyof typeof UNITS
  return Math.max(1, Math.round((Number(m?.[1] ?? 0) * UNITS[unit]) / UNITS.m))
}

/** How a host program runs an argv in the VM, as the image's user, with its stdin piped. */
export type Guest = { argv(argv: readonly string[]): string[] }

export const tartGuest = (vm: string): Guest => ({
  argv: (argv) => ['tart', 'exec', '-i', vm, ...argv],
})

/** SSH joins its arguments into one command line for the remote shell, so each is quoted. */
export const sshGuest = (host: string, key: string, user = DEFAULT_SSH_USER): Guest => ({
  argv: (argv) => ['ssh', '-i', key, ...SSH_OPTIONS, `${user}@${host}`, argv.map(q).join(' ')],
})

const runIn = (
  guest: Guest,
  argv: readonly string[],
  options: { input?: string | Uint8Array; signal?: AbortSignal } = {},
) => {
  const [bin = '', ...args] = guest.argv(argv)
  return tracedRun(bin, args, { input: options.input ?? '', signal: options.signal })
}

/**
 * The gateway's commands run as root through `sudo -n`, which the image's user needs without a
 * password. The agent runs as that same user, so it could stop or replace the forwarder: only
 * the real credentials, which never leave the host, are out of its reach. Killing `tart exec` or
 * `ssh` can leave them running in the VM, so the gateway stops its forwarder itself.
 */
export const rootTransport = (guest: Guest): ExecTransport => ({
  argv: (command) =>
    guest.argv([
      'sudo',
      '-n',
      '/bin/sh',
      '-c',
      `PATH=${GUEST_PATH}:$PATH; exec "$@"`,
      'sh',
      ...command,
    ]),
  orphans: true,
})

/**
 * A command as one script on stdin, so variables (and what a secret holds) never reach a
 * command line on the host or in the VM. The shell records its pid for {@link killTree}.
 */
export function execScript(o: {
  command: string
  cwd: string
  env: Record<string, string>
  pidFile: string
}): string {
  const exports = Object.entries(o.env)
    .filter(([k]) => NAME.test(k))
    .map(([k, v]) => `export ${k}=${q(v)}`)
  return [
    [
      `echo $$ > ${q(o.pidFile)}`,
      `export PATH=${GUEST_PATH}:"$PATH"`,
      ...exports,
      'umask 022',
      `cd ${q(o.cwd)} || exit 1`,
    ].join('; '),
    o.command,
  ].join('\n')
}

/** Reads the script {@link execScript} wrote from stdin and runs it, with stdin then empty. */
const RUN_SCRIPT = ['/bin/bash', '-c', 's=$(cat); eval "$s" </dev/null']

/**
 * Kills the command whose shell wrote `pidFile` and everything it started: macOS has no
 * `/proc` to find them by a marker, so it walks the tree from that shell, stopping each first.
 */
export const killTree = (pidFile: string) =>
  `f=${q(pidFile)}; [ -f "$f" ] || exit 0
tree() { kill -STOP "$1" 2>/dev/null; for c in $(pgrep -P "$1"); do tree "$c"; done; kill -9 "$1" 2>/dev/null; }
tree "$(cat "$f")"; rm -f "$f"; true`

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

/** Stops and deletes a VM, never throwing: one already gone is done. */
async function removeVm(vm: string): Promise<void> {
  await tartCli(['stop', '--timeout', '5', vm]).catch(() => {})
  await tartCli(['delete', vm]).catch(() => {})
}

/** Deletes every VM a run cloned and didn't delete: a worker killed mid-attempt leaves its own. */
export async function removeRunVms(runId: string): Promise<void> {
  const names = await tartNames().catch(() => new Set<string>())
  const prefix = vmPrefix(runId)
  for (const vm of names) if (vm.startsWith(prefix)) await removeVm(vm)
}

export async function createTartSandbox(
  descriptor: TartSandboxDescriptor,
  options: SandboxOptions,
): Promise<Sandbox> {
  const { signal } = options
  // Planning refuses every other policy; a VM on Tart's network can't be held to one.
  if (options.egress.policy !== 'allow-all') {
    throw new InfraError(
      `tart() runs under egress 'allow-all' only, and this attempt asked for ${JSON.stringify(options.egress.policy)}`,
    )
  }
  const debug = attemptDebug()
  const vm = `${vmPrefix(options.runId)}${randomBytes(3).toString('hex')}`
  const started = performance.now()
  let booted: ChildProcess | undefined
  let ended: Promise<unknown> = Promise.resolve()
  let gateway: Gateway | undefined
  let removed: Promise<void> | undefined
  const destroy = () => {
    removed ??= (async () => {
      await gateway?.close()
      await tartCli(['stop', '--timeout', '5', vm]).catch(() => {})
      // A VM is deleted only once `tart run` no longer holds it.
      booted?.kill('SIGKILL')
      await ended
      await tartCli(['delete', vm]).catch(() => {})
      debug?.log('container', `deleted ${vm}`)
    })()
    return removed
  }
  const fail = async (error: unknown): Promise<never> => {
    await destroy()
    if (signal.aborted) throw signal.reason
    throw error instanceof InfraError ? error : new InfraError((error as Error).message)
  }

  try {
    await tartOk(['clone', descriptor.image, vm], { signal })
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw new InfraError(`Couldn't clone ${descriptor.image}: ${(error as Error).message}`)
  }
  let guest: Guest = tartGuest(vm)
  try {
    const set = [
      ...(descriptor.cpus !== undefined ? ['--cpu', String(descriptor.cpus)] : []),
      ...(descriptor.memory !== undefined ? ['--memory', String(memoryMb(descriptor.memory))] : []),
    ]
    if (set.length) await tartOk(['set', vm, ...set], { signal })
    let exited: string | undefined
    let stderr = ''
    booted = spawn('tart', ['run', vm, '--no-graphics'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    })
    const run = booted
    ended = new Promise((resolve) => {
      run.once('exit', resolve)
      run.once('error', resolve)
    })
    booted.stderr?.on('data', (d) => {
      stderr = `${stderr}${d}`.slice(-2000)
    })
    booted.once('error', (error) => {
      exited = error.message
    })
    booted.once('exit', (code) => {
      const why = stderr.trim()
      exited = `tart run exited (${code})${why ? `: ${why}` : ''}`
      if (/exceeds the system limit/i.test(why)) {
        exited += `. macOS runs two macOS VMs at a time, and VMs outside this run hold the slots. Stop them (tart stop <name>), or run fewer: tart({ maxConcurrent: 1 })`
      }
    })
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    /** Whether `g` runs a command within `ms`, and the boot deadline. */
    const answers = async (g: Guest, ms = PROBE_TIMEOUT_MS) => {
      const wait = Math.max(1, Math.min(ms, deadline - Date.now()))
      const probe = AbortSignal.any([signal, AbortSignal.timeout(wait)])
      try {
        return (await runIn(g, ['true'], { signal: probe })).exitCode === 0
      } catch (error) {
        if (signal.aborted) throw error
        return false
      }
    }
    const ssh = descriptor.ssh
    /** `tart exec` when the image's Guest Agent answers, else SSH when the eval gave a key. */
    const reach = async (): Promise<Guest | undefined> => {
      if (await answers(tartGuest(vm), ssh ? EXEC_PROBE_WITH_SSH_MS : PROBE_TIMEOUT_MS)) {
        return tartGuest(vm)
      }
      if (!ssh) return undefined
      const ip = await tartCli(['ip', vm, '--wait', '5'], { signal })
      const host = ip.stdout.trim()
      if (ip.exitCode !== 0 || !host) return undefined
      const viaSsh = sshGuest(host, ssh.key, ssh.user)
      return (await answers(viaSsh)) ? viaSsh : undefined
    }
    for (;;) {
      if (exited) throw new InfraError(`${vm} didn't boot: ${exited}`)
      const reached = await untraced(reach)
      if (reached) {
        guest = reached
        break
      }
      if (Date.now() > deadline) {
        throw new InfraError(
          `${vm} answered neither tart exec${ssh ? ' nor SSH' : ''} within ${BOOT_TIMEOUT_MS / 1000}s of booting${ssh ? '' : ': an image without the Tart Guest Agent needs tart({ ssh: { key } })'}`,
        )
      }
      await sleep(1000, signal)
    }
  } catch (error) {
    return fail(error)
  }
  debug?.log(
    'container',
    `booted ${vm} from ${descriptor.image} in ${Math.round(performance.now() - started)}ms, reached over ${guest.argv([])[0] === 'ssh' ? 'SSH' : 'tart exec'}`,
  )

  let home: string
  try {
    home = (await runIn(guest, ['/bin/sh', '-c', 'printf %s "$HOME"'], { signal })).stdout
    if (!home.startsWith('/')) throw new InfraError(`${vm} has no home directory for its user`)
  } catch (error) {
    return fail(error)
  }
  const workdir = posix.join(home, 'workspace')
  const stateDir = posix.join(home, '.reeval-state')
  const made = await runIn(guest, [
    '/bin/sh',
    '-c',
    `umask 022 && mkdir -p ${q(workdir)} ${q(stateDir)} && chmod 700 ${q(stateDir)}`,
  ]).catch((error: Error) => ({ exitCode: 1, stderr: error.message }))
  if (made.exitCode !== 0) return fail(new Error(`Couldn't set up ${vm}: ${made.stderr.trim()}`))

  const brokered = [...new Set((options.substitutions ?? []).map((s) => s.name))]
  try {
    gateway = await startGateway(
      rootTransport(guest),
      { policy: gatewayPolicy(options.egress) },
      signal,
    )
    debug?.log('container', `egress gateway started · brokers ${brokered.join(', ') || 'nothing'}`)
  } catch (error) {
    if (signal.aborted) return fail(signal.reason)
    const reason = (error as Error).message
    // Under allow-all the VM keeps its own network, so the gateway only records and brokers.
    if (brokered.length) {
      return fail(
        new InfraError(
          `Can't keep ${brokered.join(', ')} out of the sandbox: credential brokering could not start (${reason}). The egress gateway needs Node in the image (brew install node) and passwordless sudo for its user.`,
        ),
      )
    }
    debug?.log('container', `egress gateway not running: ${reason}`)
  }

  let execs = 0
  const resolve = (path: string) =>
    path.startsWith('~/') ? posix.join(home, path.slice(2)) : posix.resolve(workdir, path)
  const execIn = async (
    command: string,
    o: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  ) => {
    const pidFile = posix.join(stateDir, `exec-${++execs}.pid`)
    try {
      const r = await runIn(guest, RUN_SCRIPT, {
        input: execScript({ command, cwd: o.cwd, env: o.env, pidFile }),
        signal: o.signal,
      })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    } catch (error) {
      if (o.signal?.aborted)
        await runIn(guest, ['/bin/sh', '-c', killTree(pidFile)]).catch(() => {})
      throw error
    }
  }

  return {
    workdir,
    home,
    stateDir,
    exec: (command, opts) =>
      execIn(command, {
        cwd: opts?.cwd ? posix.resolve(workdir, opts.cwd) : workdir,
        env: { ...gateway?.env, ...options.env, ...opts?.env },
        signal: opts?.signal,
      }),
    execOwn: (command, opts) => execIn(command, { cwd: stateDir, env: {}, signal: opts?.signal }),
    async readFile(path) {
      const r = await runIn(guest, ['/bin/cat', '--', resolve(path)]).catch(() => null)
      return r?.exitCode === 0 ? r.stdout : null
    },
    async writeFile(path, content) {
      const target = resolve(path)
      const r = await runIn(
        guest,
        ['/bin/sh', '-c', 'umask 022 && mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', target],
        { input: content },
      )
      if (r.exitCode !== 0) throw new Error(`Couldn't write ${target} in ${vm}: ${r.stderr.trim()}`)
    },
    ...(gateway && {
      setSubstitutions: async (subs) => gateway?.setSubstitutions(subs),
      traffic: () => (gateway as Gateway).traffic(),
    }),
    async getPortEndpoint({ port, protocol = 'http' }) {
      const scheme = protocol === 'ws' ? 'ws' : 'http'
      if (gateway && !gateway.stopped) return { url: await gateway.portUrl(port, scheme) }
      const ip = (await tartOk(['ip', vm])).trim()
      return { url: `${scheme}://${ip}:${port}` }
    },
    destroy,
  }
}
