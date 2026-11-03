// The Tart sandbox: one macOS VM per attempt, cloned from the image, booted headless, reached
// over `tart exec` (or SSH) and deleted when the attempt ends.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import {
  CA_PATH,
  type DockerSession,
  type EgressStatus,
  type ExecTransport,
  type Gateway,
  type NetworkPolicy,
  pathOperations,
  startGateway,
  traceDocker,
  WORKSPACE_DIR,
} from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import { attemptDebug } from '../debug/attempt.ts'
import { untraced } from '../debug/docker.ts'
import type { TartSandboxDescriptor } from '../types.ts'
import { gatewayGlue, sessionSandbox } from './docker.ts'
import type { SandboxOptions } from './index.ts'
import { tartCli, tartNames, tartOk, tracedRun, tracedRunBytes } from './tart-cli.ts'
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
  /** Before the VM's own PATH; {@link GUEST_PATH} by default. */
  path?: string
}): string {
  const exports = Object.entries(o.env)
    .filter(([k]) => NAME.test(k))
    .map(([k, v]) => `export ${k}=${q(v)}`)
  return [
    [
      `echo $$ > ${q(o.pidFile)}`,
      `export PATH=${q(o.path ?? GUEST_PATH)}:"$PATH"`,
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

/** A booted clone: how to reach it, its user's home, and how to shut it down. */
export type BootedVm = {
  guest: Guest
  home: string
  /** Stops the VM and waits for `tart run` to let it go; idempotent. A clean shutdown gets `timeoutS`. */
  halt: (timeoutS?: number) => Promise<void>
}

/**
 * Clones `image` as `vm`, sizes and boots it headless, and waits until `tart exec` (or SSH, with
 * the eval's key) runs a command in it. A clone that doesn't boot is stopped and deleted.
 */
export async function bootTartVm(
  descriptor: TartSandboxDescriptor,
  image: string,
  vm: string,
  signal: AbortSignal,
): Promise<BootedVm> {
  const debug = attemptDebug()
  const started = performance.now()
  let booted: ChildProcess | undefined
  let ended: Promise<unknown> = Promise.resolve()
  let halted: Promise<void> | undefined
  const halt = (timeoutS = 5) => {
    halted ??= (async () => {
      await tartCli(['stop', '--timeout', String(timeoutS), vm]).catch(() => {})
      // A VM is deleted only once `tart run` no longer holds it.
      booted?.kill('SIGKILL')
      await ended
    })()
    return halted
  }
  const fail = async (error: unknown): Promise<never> => {
    await halt()
    await tartCli(['delete', vm]).catch(() => {})
    if (signal.aborted) throw signal.reason
    throw error instanceof InfraError ? error : new InfraError((error as Error).message)
  }

  try {
    await tartOk(['clone', image, vm], { signal })
  } catch (error) {
    // `vm` is a name of this attempt's or bake's own, so whatever the clone left is ours.
    await tartCli(['delete', vm]).catch(() => {})
    if (signal.aborted) throw signal.reason
    throw new InfraError(`Couldn't clone ${image}: ${(error as Error).message}`)
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
    `booted ${vm} from ${image} in ${Math.round(performance.now() - started)}ms, reached over ${guest.argv([])[0] === 'ssh' ? 'SSH' : 'tart exec'}`,
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
  const debug = attemptDebug()
  const vm = `${vmPrefix(options.runId)}${randomBytes(3).toString('hex')}`
  let gateway: Gateway | undefined
  let removed: Promise<void> | undefined
  // The image preflight baked the harness into, when it did.
  const { guest, home, halt } = await bootTartVm(
    descriptor,
    options.image ?? descriptor.image,
    vm,
    signal,
  )
  const destroy = () => {
    removed ??= (async () => {
      await gateway?.close()
      await halt()
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

  const workdir = posix.join(home, WORKSPACE_DIR)
  const stateDir = posix.join(home, '.reeval-state')
  const made = await runIn(guest, [
    '/bin/sh',
    '-c',
    `umask 022 && mkdir -p ${q(workdir)} ${q(stateDir)} && chmod 700 ${q(stateDir)}`,
  ]).catch((error: Error) => ({ exitCode: 1, stderr: error.message }))
  if (made.exitCode !== 0) return fail(new Error(`Couldn't set up ${vm}: ${made.stderr.trim()}`))

  const glue = gatewayGlue(options)
  const { brokered } = glue
  let noGateway: string | undefined
  let caBundle: string | undefined
  try {
    gateway = await startGateway(rootTransport(guest), glue.egress, signal)
    debug?.log('container', `egress gateway started · brokers ${brokered.join(', ') || 'nothing'}`)
  } catch (error) {
    if (signal.aborted) return fail(signal.reason)
    noGateway = (error as Error).message
    // Under allow-all the VM keeps its own network, so the gateway only records and brokers.
    if (brokered.length) {
      return fail(
        new InfraError(
          `Can't keep ${brokered.join(', ')} out of the sandbox: credential brokering could not start (${noGateway}). The egress gateway needs Node in the image (brew install node) and passwordless sudo for its user.`,
        ),
      )
    }
    debug?.log('container', `egress gateway not running: ${noGateway}`)
  }
  if (gateway) {
    const trusted = await runIn(guest, ['sudo', '-n', ...TRUST_CA], {
      signal: AbortSignal.any([signal, AbortSignal.timeout(TRUST_TIMEOUT_MS)]),
    }).catch((error: Error) => ({ exitCode: 1, stderr: error.message }))
    debug?.log(
      'container',
      trusted.exitCode === 0
        ? 'the gateway CA is trusted in the System keychain'
        : `the gateway CA isn't in the System keychain (${trusted.stderr.trim().slice(-300) || `exit ${trusted.exitCode}`}): clients that read only the keychain don't trust the proxy`,
    )
    if (signal.aborted) return fail(signal.reason)
    const bundle = posix.join(stateDir, 'ca-bundle.pem')
    const bundled = await runIn(guest, ['/bin/sh', '-c', CA_BUNDLE_SCRIPT, 'sh', bundle], {
      signal,
    }).catch((error: Error) => ({ exitCode: 1, stderr: error.message }))
    if (signal.aborted) return fail(signal.reason)
    if (bundled.exitCode === 0) caBundle = bundle
    else
      debug?.log(
        'container',
        `no CA bundle for the gateway: ${bundled.stderr.trim() || `exit ${bundled.exitCode}`}`,
      )
  }

  try {
    const network = tartSession({
      vm,
      guest,
      home,
      stateDir,
      env: options.env,
      gateway,
      noGateway,
      caBundle,
      destroy,
    })
    return await sessionSandbox(network, glue, { stateDir, oomKills: async () => null })
  } catch (error) {
    return fail(error)
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
}

/**
 * The VM as an AI SDK harness session. Every process, reeval's own included, runs as the image's
 * user: macOS has no `useradd`, and the gateway's forwarder needs that user's `sudo`. Each gets
 * its variables in a script on stdin ({@link execScript}), and a relative path is under the home
 * directory, so the session's workspace is `~/workspace`.
 */
export function tartSession(o: TartSessionOptions): DockerSession {
  const { vm, guest, home, stateDir, gateway } = o
  const description = `tart VM ${vm}`
  const path = `${posix.join(home, PNPM_DIR, 'bin')}:${GUEST_PATH}`
  let execs = 0
  const nextPidFile = () => posix.join(stateDir, `exec-${++execs}.pid`)
  const at = (path?: string) => (path ? posix.resolve(home, path) : home)
  const envFor = (env?: Record<string, string>) => ({
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
  })
  const killExec = (pidFile: string) =>
    runIn(guest, ['/bin/sh', '-c', killTree(pidFile)]).then(
      () => {},
      () => {},
    )
  const execIn = async (
    command: string,
    cwd: string,
    env: Record<string, string>,
    signal?: AbortSignal,
  ) => {
    const pidFile = nextPidFile()
    try {
      const r = await runIn(guest, RUN_SCRIPT, {
        input: execScript({ command, cwd, env, pidFile, path }),
        ...(signal && { signal }),
      })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    } catch (error) {
      if (signal?.aborted) await killExec(pidFile)
      throw error
    }
  }

  const readBinaryFile = async (r: { path: string; abortSignal?: AbortSignal }) => {
    const [bin = '', ...args] = guest.argv(['/bin/cat', '--', at(r.path)])
    const read = await tracedRunBytes(bin, args, {
      ...(r.abortSignal && { signal: r.abortSignal }),
    }).catch(() => null)
    return read?.exitCode === 0 ? new Uint8Array(read.stdout) : null
  }
  const writeBinaryFile = async (w: {
    path: string
    content: Uint8Array
    abortSignal?: AbortSignal
  }) => {
    const target = at(w.path)
    const r = await runIn(
      guest,
      ['/bin/sh', '-c', 'umask 022 && mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', target],
      { input: w.content, ...(w.abortSignal && { signal: w.abortSignal }) },
    )
    if (r.exitCode !== 0) throw new Error(`Couldn't write ${target} in ${vm}: ${r.stderr.trim()}`)
  }
  const paths = pathOperations(
    (script, path, abortSignal) =>
      runIn(guest, ['/bin/sh', '-c', script, 'sh', path], {
        ...(abortSignal && { signal: abortSignal }),
      }),
    home,
  )

  const brokering: Partial<DockerSession> = gateway
    ? {
        async setNetworkPolicy(policy: NetworkPolicy) {
          gateway.setPolicy(policy)
        },
        async addRequestTransformations(rules) {
          gateway.addTransformations(rules)
        },
        async setRequestTransformations(rules) {
          gateway.setTransformations(rules)
        },
        async setSubstitutions(subs) {
          gateway.setSubstitutions(subs)
        },
        traffic: () => gateway.traffic(),
      }
    : {}

  const session: DockerSession = {
    id: vm,
    description,
    defaultWorkingDirectory: home,
    ports: [],
    get egress(): EgressStatus | undefined {
      if (!gateway) return o.noGateway ? { active: false, reason: o.noGateway } : undefined
      return gateway.stopped ? { active: false, reason: gateway.stopped } : { active: true }
    },
    ...brokering,
    oomKills: async () => null,
    run: (r) => execIn(r.command, at(r.workingDirectory), envFor(r.env), r.abortSignal),
    runPrivileged: (r) => execIn(r.command, stateDir, {}, r.abortSignal),
    spawn: (async (s: Parameters<DockerSession['spawn']>[0]) => {
      if (s.stdin) throw new Error(`A process in ${description} has no writable stdin`)
      const pidFile = nextPidFile()
      const [bin = '', ...args] = guest.argv(RUN_SCRIPT)
      const startedAt = Date.now()
      const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      child.stdin.on('error', () => {})
      child.stdin.end(
        execScript({
          command: s.command,
          cwd: at(s.workingDirectory),
          env: envFor(s.env),
          pidFile,
          path,
        }),
      )
      const exited = new Promise<{ exitCode: number }>((resolve) => {
        child.once('error', () => resolve({ exitCode: 127 }))
        child.once('close', (code) => {
          traceDocker(args, startedAt, { exitCode: code, stdout: '<streamed>' }, bin)
          resolve({ exitCode: code ?? 1 })
        })
      })
      const kill = async () => {
        child.kill('SIGKILL')
        await killExec(pidFile)
      }
      s.abortSignal?.addEventListener('abort', () => void kill(), { once: true })
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill,
      }
    }) as unknown as DockerSession['spawn'],
    readBinaryFile,
    async readFile(r) {
      const bytes = await readBinaryFile(r)
      return bytes === null
        ? null
        : (Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>)
    },
    async readTextFile(r) {
      const bytes = await readBinaryFile(r)
      if (bytes === null) return null
      const text = Buffer.from(bytes).toString('utf8')
      if (r.startLine === undefined && r.endLine === undefined) return text
      return text
        .split('\n')
        .slice((r.startLine ?? 1) - 1, r.endLine)
        .join('\n')
    },
    ...paths,
    writeBinaryFile,
    writeTextFile: (w) => writeBinaryFile({ ...w, content: Buffer.from(w.content, 'utf8') }),
    async writeFile(w) {
      const chunks: Uint8Array[] = []
      for await (const chunk of w.content) chunks.push(chunk)
      await writeBinaryFile({ ...w, content: Buffer.concat(chunks) })
    },
    async getPortEndpoint({ port, protocol = 'ws' }) {
      const scheme = protocol === 'ws' ? 'ws' : 'http'
      if (gateway && !gateway.stopped) return { url: await gateway.portUrl(port, scheme) }
      const ip = (await tartOk(['ip', vm])).trim()
      return { url: `${scheme}://${ip}:${port}` }
    },
    async getPortUrl(p) {
      return (await session.getPortEndpoint(p)).url
    },
    stop: o.destroy,
    destroy: o.destroy,
    restricted: () => {
      const { readFile, readTextFile, writeFile, writeTextFile, stat, listDirectory } = session
      const { deleteFile, run } = session
      return {
        description,
        readFile,
        readBinaryFile,
        readTextFile,
        writeFile,
        writeBinaryFile,
        writeTextFile,
        stat,
        listDirectory,
        deleteFile,
        spawn: session.spawn,
        run,
      }
    },
  }
  return session
}
