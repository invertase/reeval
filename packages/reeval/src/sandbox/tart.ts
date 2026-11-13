// The Tart sandbox: one macOS VM per attempt, cloned from the image, booted headless, reached
// over `tart exec` (or SSH) and deleted when the attempt ends.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import {
  CA_PATH,
  type DockerSession,
  darwinShell,
  type ExecTransport,
  type Gateway,
  transportSession,
  WORKSPACE_DIR,
} from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import { attemptDebug } from '../debug/attempt.ts'
import { untraced } from '../debug/docker.ts'
import { attemptSpan, openSpan } from '../trace/spans.ts'
import type { TartSandboxDescriptor } from '../types.ts'
import type { SandboxOptions } from './index.ts'
import { type BootedMachine, startSandbox } from './start.ts'
import {
  LOCAL_TART,
  runArgv,
  type TartTarget,
  tartCli,
  tartNames,
  tartOk,
  tracedRun,
  tracedRunBytes,
} from './tart-cli.ts'
import {
  AT_VM_LIMIT,
  BUSY_COOLDOWN_MS,
  BUSY_WAIT_MS,
  claimHost,
  freeSlots,
  HostTaken,
  hostLoad,
  hostSlots,
  TartBusyError,
  withHostClaim,
} from './tart-hosts.ts'
import { InfraError, type NetworkSandbox } from './types.ts'

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
/** Where a baked image has reeval's pinned pnpm, relative to the image user's home; first on PATH. */
export const PNPM_DIR = '.reeval-state/pnpm'
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
const UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const

/**
 * Deletes the VM `$1` on a host once no `tart clone` is still making it, in the background: killing
 * the local ssh leaves the remote clone running, and it would leave its VM behind. `[t]art` keeps
 * the pattern from matching this shell's own command line.
 */
const DELETE_AFTER_CLONE = `( i=0; while [ $i -lt 600 ] && pgrep -f "[t]art clone .* $1\\$" >/dev/null; do sleep 1; i=$((i+1)); done; tart delete "$1" ) </dev/null >/dev/null 2>&1 &`

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

export const tartGuest = (vm: string, on: TartTarget = LOCAL_TART): Guest => ({
  argv: (argv) => on.tart(['exec', '-i', vm, ...argv]),
})

/**
 * SSH joins its arguments into one command line for the remote shell, so each is quoted. A VM on
 * another Mac is reached through that Mac: `proxy` is the `ProxyCommand` that gets there.
 */
export const sshGuest = (
  host: string,
  key: string,
  user = DEFAULT_SSH_USER,
  proxy?: string,
): Guest => ({
  argv: (argv) => [
    'ssh',
    '-i',
    key,
    ...SSH_OPTIONS,
    ...(proxy ? ['-o', `ProxyCommand=${proxy}`] : []),
    `${user}@${host}`,
    argv.map(q).join(' '),
  ],
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
async function removeVm(vm: string, on: TartTarget): Promise<void> {
  await tartCli(['stop', '--timeout', '5', vm], { on }).catch(() => {})
  await tartCli(['delete', vm], { on }).catch(() => {})
}

/**
 * Deletes every VM a run cloned and didn't delete, on this machine or each of `targets`: a worker
 * killed mid-attempt leaves its own.
 */
export async function removeRunVms(
  runId: string,
  targets: readonly TartTarget[] = [LOCAL_TART],
): Promise<void> {
  const prefix = vmPrefix(runId)
  await Promise.all(
    targets.map(async (on) => {
      const names = await tartNames(undefined, on).catch(() => new Set<string>())
      for (const vm of names) if (vm.startsWith(prefix)) await removeVm(vm, on)
    }),
  )
}

/** A booted clone: how to reach it, its user's home, and how to shut it down. */
export type BootedVm = {
  guest: Guest
  home: string
  /** Stops the VM and waits for `tart run` to let it go; idempotent. A clean shutdown gets `timeoutS`. */
  halt: (timeoutS?: number) => Promise<void>
}

/**
 * Clones `image` as `vm` on `on`, sizes and boots it headless, and waits until `tart exec` (or
 * SSH, with the eval's key) runs a command in it. A clone that doesn't boot is stopped and
 * deleted; one its host refuses for being at its VM limit throws {@link TartBusyError}.
 */
export async function bootTartVm(
  descriptor: TartSandboxDescriptor,
  image: string,
  vm: string,
  signal: AbortSignal,
  on: TartTarget = LOCAL_TART,
  o: {
    /** Runs the clone: bootOnHost's holds the host's claim lock around it. */
    claim?: (clone: () => Promise<void>) => Promise<void>
  } = {},
): Promise<BootedVm> {
  const debug = attemptDebug()
  const started = performance.now()
  let booted: ChildProcess | undefined
  let ended: Promise<unknown> = Promise.resolve()
  let halted: Promise<void> | undefined
  const halt = (timeoutS = 5) => {
    halted ??= (async () => {
      await tartCli(['stop', '--timeout', String(timeoutS), vm], { on }).catch(() => {})
      // A VM is deleted only once `tart run` no longer holds it.
      booted?.kill('SIGKILL')
      await ended
    })()
    return halted
  }
  const fail = async (error: unknown): Promise<never> => {
    await halt()
    await tartCli(['delete', vm], { on }).catch(() => {})
    if (signal.aborted) throw signal.reason
    throw error instanceof InfraError ? error : new InfraError((error as Error).message)
  }

  try {
    const clone = async () => {
      await tartOk(['clone', image, vm], { signal, on })
    }
    await (o.claim ? o.claim(clone) : clone())
  } catch (error) {
    if (error instanceof HostTaken) throw error
    // `vm` is a name of this attempt's or bake's own, so whatever the clone left is ours.
    await tartCli(['delete', vm], { on }).catch(() => {})
    if (signal.aborted) {
      if (on.remote) await runArgv(on.sh(DELETE_AFTER_CLONE, [vm])).catch(() => {})
      throw signal.reason
    }
    throw new InfraError(`Couldn't clone ${image}: ${(error as Error).message}`)
  }
  let guest: Guest = tartGuest(vm, on)
  try {
    const set = [
      ...(descriptor.cpus !== undefined ? ['--cpu', String(descriptor.cpus)] : []),
      ...(descriptor.memory !== undefined ? ['--memory', String(memoryMb(descriptor.memory))] : []),
    ]
    if (set.length) await tartOk(['set', vm, ...set], { signal, on })
    let exited: string | undefined
    let busy = false
    let stderr = ''
    const [bin = '', ...args] = on.tart(['run', vm, '--no-graphics'])
    booted = spawn(bin, args, {
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
    // What `tart run` said can arrive after it exits (ssh passes it on): read it once it's in.
    booted.once('close', (code) => {
      const why = stderr.trim()
      exited = `tart run exited (${code})${why ? `: ${why}` : ''}`
      busy = on.remote && AT_VM_LIMIT.test(why)
      if (AT_VM_LIMIT.test(why) && !on.remote) {
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
      if (await answers(tartGuest(vm, on), ssh ? EXEC_PROBE_WITH_SSH_MS : PROBE_TIMEOUT_MS)) {
        return tartGuest(vm, on)
      }
      if (!ssh) return undefined
      const ip = await tartCli(['ip', vm, '--wait', '5'], { signal, on })
      const host = ip.stdout.trim()
      if (ip.exitCode !== 0 || !host) return undefined
      const viaSsh = sshGuest(host, ssh.key, ssh.user, on.proxy)
      return (await answers(viaSsh)) ? viaSsh : undefined
    }
    for (;;) {
      if (busy) throw new TartBusyError(`${on.label} is at its VM limit: ${exited}`)
      if (exited)
        throw new InfraError(`${vm} didn't boot${on.remote ? ` on ${on.label}` : ''}: ${exited}`)
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
    `booted ${vm} from ${image}${on.remote ? ` on ${on.label}` : ''} in ${Math.round(performance.now() - started)}ms, reached over ${guest.argv([])[0] === 'ssh' ? 'SSH' : 'tart exec'}`,
  )
  let home: string
  try {
    home = (await runIn(guest, ['/bin/sh', '-c', 'printf %s "$HOME"'], { signal })).stdout
    if (!home.startsWith('/')) throw new InfraError(`${vm} has no home directory for its user`)
  } catch (error) {
    return fail(error)
  }
  return { guest, home, halt }
}

/**
 * Boots the attempt's VM: on this machine, or with `tart({ hosts })` on the host with the most room,
 * passing over one whose `tart run` says it's at its VM limit for a while and trying the next. The
 * host's slot is claimed under its lock: counted again, then cloned into.
 */
export async function bootOnHost(
  descriptor: TartSandboxDescriptor,
  image: string,
  vm: string,
  options: Pick<SandboxOptions, 'signal' | 'runId' | 'hosts'>,
  o: { waitMs?: number } = {},
): Promise<BootedVm & { on: TartTarget }> {
  const { signal } = options
  if (!descriptor.hosts) {
    return { ...(await bootTartVm(descriptor, image, vm, signal)), on: LOCAL_TART }
  }
  const debug = attemptDebug()
  const slots = hostSlots(descriptor, options.hosts, image)
  if (!slots.length)
    throw new InfraError('tart() has no host left to run on: preflight skipped every one')
  const busy = new Map<string, number>()
  const deadline = { at: Date.now() + (o.waitMs ?? BUSY_WAIT_MS) }
  const prefix = vmPrefix(options.runId)
  const log = (line: string) => debug?.log('container', line)
  for (;;) {
    const slot = await claimHost(slots, { signal, busy, prefix, deadline, log })
    const claim = (clone: () => Promise<void>) =>
      withHostClaim(slot.target, signal, async () => {
        if (freeSlots(slot.vms, await hostLoad(slot.target, prefix, signal)) < 1) {
          throw new HostTaken(`${slot.target.label} filled up`)
        }
        await clone()
      })
    try {
      const booted = await bootTartVm(descriptor, slot.image, vm, signal, slot.target, { claim })
      return { ...booted, on: slot.target }
    } catch (error) {
      if (error instanceof HostTaken) {
        log(`${error.message} before this attempt cloned there: picking again`)
        continue
      }
      if (!(error instanceof TartBusyError)) throw error
      log(`${error.message}: trying another host`)
      busy.set(slot.target.label, Date.now() + BUSY_COOLDOWN_MS)
    }
  }
}

export async function createTartSandbox(
  descriptor: TartSandboxDescriptor,
  options: SandboxOptions,
): Promise<NetworkSandbox> {
  const { signal } = options
  // Planning refuses every other policy; a VM on Tart's network can't be held to one.
  if (options.egress.policy !== 'allow-all') {
    throw new InfraError(
      `tart() runs under egress 'allow-all' only, and this attempt asked for ${JSON.stringify(options.egress.policy)}`,
    )
  }
  const vm = `${vmPrefix(options.runId)}${randomBytes(3).toString('hex')}`
  const span = openSpan('machine', { 'reeval.sandbox': 'tart', 'host.id': vm, 'host.name': vm })
  attemptSpan()?.set({ 'reeval.sandbox': 'tart', 'host.id': vm })
  try {
    return await startSandbox(options, {
      helper: 'tart()',
      machine: { sandbox: 'tart' },
      darwin: true,
      hint: 'The egress gateway needs Node in the image (brew install node) and passwordless sudo for its user.',
      // The image preflight baked the harness into, when it did.
      install: false,
      boot: async () => {
        const booted = await bootTart(descriptor, options, vm).catch((error: unknown) => {
          span.end(error)
          throw error
        })
        const destroy = booted.destroy
        return {
          ...booted,
          destroy: async () => {
            try {
              await destroy()
            } finally {
              span.end()
            }
          },
        }
      },
    })
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw error instanceof InfraError ? error : new InfraError((error as Error).message)
  }
}

/** Boots `vm` on a host and makes its workspace and state directory. */
async function bootTart(
  descriptor: TartSandboxDescriptor,
  options: SandboxOptions,
  vm: string,
): Promise<BootedMachine> {
  const { signal } = options
  const debug = attemptDebug()
  let removed: Promise<void> | undefined
  const { guest, home, halt, on } = await bootOnHost(
    descriptor,
    options.image ?? descriptor.image,
    vm,
    options,
  )
  const destroy = () => {
    removed ??= (async () => {
      await halt()
      await tartCli(['delete', vm], { on }).catch(() => {})
      debug?.log('container', `deleted ${vm}${on.remote ? ` on ${on.label}` : ''}`)
    })()
    return removed
  }
  const workdir = posix.join(home, WORKSPACE_DIR)
  const stateDir = posix.join(home, '.reeval-state')
  const made = await runIn(guest, [
    '/bin/sh',
    '-c',
    `umask 022 && mkdir -p ${q(workdir)} ${q(stateDir)} && chmod 700 ${q(stateDir)}`,
  ]).catch((error: Error) => ({ exitCode: 1, stderr: error.message }))
  if (made.exitCode !== 0) {
    await destroy()
    throw new Error(`Couldn't set up ${vm}: ${made.stderr.trim()}`)
  }
  let caBundle: string | undefined
  return {
    vm: { id: vm },
    root: rootTransport(guest),
    stateDir,
    destroy,
    async onGateway() {
      const trustStarted = Date.now()
      const trusted = await runIn(guest, ['sudo', '-n', ...TRUST_CA], {
        signal: AbortSignal.any([signal, AbortSignal.timeout(TRUST_TIMEOUT_MS)]),
      }).catch((error: Error) => ({ exitCode: 1, stderr: error.message }))
      debug?.log(
        'container',
        trusted.exitCode === 0
          ? 'the gateway CA is trusted in the System keychain'
          : `the gateway CA isn't in the System keychain after ${((Date.now() - trustStarted) / 1000).toFixed(1)}s (${trusted.stderr.trim().slice(-300) || `exit ${trusted.exitCode}`}): clients that read only the keychain don't trust the proxy`,
      )
      if (signal.aborted) throw signal.reason
      if (trusted.exitCode !== 0 && options.keychainTrust) {
        throw new InfraError(
          `This harness's CLI trusts only the macOS keychain, and sudo security add-trusted-cert couldn't add the egress gateway's CA to ${vm}'s System keychain (${trusted.stderr.trim().slice(-300) || `exit ${trusted.exitCode}`}). In the image, allow it without a prompt: sudo security authorizationdb write com.apple.trust-settings.admin allow`,
        )
      }
      const bundle = posix.join(stateDir, 'ca-bundle.pem')
      const bundled = await runIn(guest, ['/bin/sh', '-c', CA_BUNDLE_SCRIPT, 'sh', bundle], {
        signal,
      }).catch((error: Error) => ({ exitCode: 1, stderr: error.message }))
      if (signal.aborted) throw signal.reason
      if (bundled.exitCode === 0) caBundle = bundle
      else
        debug?.log(
          'container',
          `no CA bundle for the gateway: ${bundled.stderr.trim() || `exit ${bundled.exitCode}`}`,
        )
    },
    session: ({ gateway, noGateway, destroy: close }) =>
      tartSession({
        vm,
        guest,
        home,
        stateDir,
        env: options.env,
        gateway,
        noGateway,
        caBundle,
        destroy: close,
        on,
      }),
  }
}

/** How long adding the gateway's CA to the keychain may take: a prompt would never be answered. */
const TRUST_TIMEOUT_MS = 15_000
/**
 * Trusts the gateway's CA for clients on macOS's own TLS (`curl`, `git`, Swift), which read the
 * keychain; Node reads `NODE_EXTRA_CA_CERTS`. The VM is a fresh clone, so nothing removes it.
 */
const TRUST_CA = [
  '/usr/bin/security',
  'add-trusted-cert',
  '-d',
  '-r',
  'trustRoot',
  '-k',
  '/Library/Keychains/System.keychain',
  CA_PATH,
]

/**
 * Writes `$1`: the system's CA bundle (macOS's `/etc/ssl/cert.pem`) with the gateway's CA after
 * it, for clients that read a bundle file rather than the keychain (Homebrew's `curl` and `git`,
 * Python). The CA is root's, so it's read with `sudo`.
 */
const CA_BUNDLE_SCRIPT = `s=
for f in /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt; do [ -s "$f" ] && { s=$f; break; }; done
[ -n "$s" ] || { echo "no system CA bundle" >&2; exit 1; }
umask 022
{ cat "$s" && echo && sudo -n /bin/cat ${CA_PATH}; } > "$1.tmp" && mv "$1.tmp" "$1"`

export type TartSessionOptions = {
  vm: string
  guest: Guest
  home: string
  /** Where reeval's own commands run, and each command's pid file goes. */
  stateDir: string
  /** The eval's variables, for every process the agent, setup and checks run. */
  env: Record<string, string>
  gateway: Gateway | undefined
  /** Why the gateway isn't running, when it isn't. */
  noGateway?: string
  /** The system's CA bundle with the gateway's CA in it, when one was written. */
  caBundle?: string
  /** Stops the gateway and deletes the VM. */
  destroy: () => Promise<void>
  /** The Mac the VM runs on; this machine when unset. */
  on?: TartTarget
}

/**
 * The VM as an AI SDK harness session. Every process, reeval's own included, runs as the image's
 * user: macOS has no `useradd`, and the gateway's forwarder needs that user's `sudo`. Each gets
 * its variables in a script on stdin, and a relative path is under the home
 * directory, so the session's workspace is `~/workspace`.
 */
export function tartSession(o: TartSessionOptions): DockerSession {
  const { vm, guest, home, stateDir, gateway } = o
  const description = `tart VM ${vm}`
  const path = `${posix.join(home, PNPM_DIR, 'bin')}:${GUEST_PATH}`
  const shell = darwinShell({
    run: (argv, r) => {
      const [bin = '', ...args] = argv
      return tracedRunBytes(bin, args, {
        input: r.input ?? '',
        ...(r.signal && { signal: r.signal }),
      })
    },
    guest: (argv) => guest.argv(argv),
    stateDir,
    path,
  })
  return transportSession({
    id: vm,
    description,
    name: vm,
    defaultWorkingDirectory: home,
    shell,
    env: (env) => ({
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      ...o.env,
      ...gateway?.env,
      ...(o.caBundle && {
        SSL_CERT_FILE: o.caBundle,
        REQUESTS_CA_BUNDLE: o.caBundle,
        CURL_CA_BUNDLE: o.caBundle,
        GIT_SSL_CAINFO: o.caBundle,
      }),
      ...env,
    }),
    gateway,
    egress: gateway
      ? { active: true }
      : o.noGateway
        ? { active: false, reason: o.noGateway }
        : undefined,
    async portWithoutGateway(port, scheme) {
      // A stopped gateway is refused, not routed around: the agent's proxy went with it.
      if (gateway) return gateway.portUrl(port, scheme)
      if (o.on?.remote) {
        throw new Error(
          `A port in ${description} on ${o.on.label} is reached through the egress gateway, which isn't running: ${o.noGateway ?? 'it stopped'}`,
        )
      }
      const ip = (await tartOk(['ip', vm])).trim()
      return `${scheme}://${ip}:${port}`
    },
    destroy: o.destroy,
  })
}
