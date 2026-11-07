import { posix } from 'node:path'
import type { Gateway } from './egress/gateway.ts'
import {
  controlOptions,
  type ExecTransport,
  type SshTarget,
  sshArgv,
  sshTransport,
} from './egress/transport.ts'
import { SANDBOX_USER, type SlotLayout, slotLayout } from './image.ts'
import { shellQuote as q, run as runHost } from './process.ts'
import type { DockerSession } from './session.ts'
import { EXEC_UMASK, linuxShell, SYSTEM_PATH } from './shells.ts'
import { traceDocker } from './trace.ts'
import { type SessionShell, transportSession } from './transport-session.ts'

export type SshSessionOptions = {
  target: SshTarget
  /** How messages name the sandbox: `boat sandbox bx_… (small)`. */
  description: string
  /** Set for every process the sandbox user runs; sent on each command's stdin, never in argv. */
  env?: Record<string, string>
  /**
   * The sandbox user's `PATH`, ahead of the system's. The VM's own `node` may sit where that user
   * can't read it, so `prepare` puts one where it can.
   */
  path?: readonly string[]
  /** Root shell commands that run once, after the sandbox user and its directories exist. */
  prepare?: string
  /** How long the VM may take to accept SSH after it reports ready. */
  connectTimeoutMs?: number
  abortSignal?: AbortSignal
  /**
   * Where the attempt lives, on a machine that runs several at once; setting up runs under a lock
   * the others share. Default slot 0's, the machine's only attempt.
   */
  layout?: SlotLayout
  /**
   * The slot ran an attempt before: kill what its user left running, delete its files and put its
   * home back, as {@link SshMachine.snapshotHome} took it under `home`, or empty without one.
   */
  reset?: { home?: string }
}

/** A Linux VM reeval set up over SSH, before its session: what the egress gateway starts on. */
export type SshMachine = {
  /** Runs the gateway's forwarder as root, over the session's connection. */
  root: ExecTransport
  /** The sandbox user's home came back from a snapshot, with what was installed in it. */
  restored: boolean
  /** Keeps the sandbox user's home as it is now under `label`, for a later reset. */
  snapshotHome(label: string): Promise<void>
  /**
   * The VM as a harness session, on `gateway` when it started (or with why it didn't). Its
   * `destroy` is the caller's: close the gateway, then {@link SshMachine.close}, then the VM.
   */
  session(o: {
    gateway: Gateway | undefined
    noGateway: string | undefined
    destroy: () => Promise<void>
  }): DockerSession
  /** Closes the shared SSH connection. */
  close(): Promise<void>
}

/** ssh's own exit status: it couldn't connect, or the connection dropped. */
const SSH_FAILED = 255
/** Held while one slot sets up, so slots sharing a machine don't install the same things at once. */
const SETUP_LOCK = '/var/lock/reeval-setup'
/** Each slot's home snapshots, root's: `<user>/home-<label>.tar`. */
const HOME_SNAPSHOTS = '/var/lib/reeval-pool'
const RESTORED = 'reeval:home-restored'

const snapshotFile = (layout: SlotLayout, label: string) =>
  `${HOME_SNAPSHOTS}/${layout.user}/home-${label.replace(/[^A-Za-z0-9._-]/g, '_')}.tar`

/**
 * Root commands that put a used slot back as a new one finds it: none of its user's processes,
 * cron jobs or temporary files, an empty working root and state directory, and its home from the
 * snapshot (printing {@link RESTORED}) or the skeleton.
 */
export function resetSlot(layout: SlotLayout, home?: string): string {
  const u = q(layout.user)
  const snapshot = home ? q(snapshotFile(layout, home)) : ''
  const parent = q(posix.dirname(layout.home))
  return [
    `if id -u ${u} >/dev/null 2>&1; then`,
    `for i in 1 2 3 4 5 6 7 8 9 10; do pkill -KILL -u ${u} || break; sleep 0.2; done`,
    `crontab -r -u ${u} 2>/dev/null`,
    `find /tmp /var/tmp /dev/shm -xdev -mindepth 1 -user ${u} -delete 2>/dev/null`,
    `rm -rf ${q(layout.root)} ${q(layout.state)} ${q(layout.home)}`,
    ...(snapshot
      ? [
          `if [ -f ${snapshot} ]; then tar -C ${parent} -xpf ${snapshot} && echo ${RESTORED}; else cp -a /etc/skel ${q(layout.home)} && chown -R ${u}:${u} ${q(layout.home)}; fi`,
        ]
      : [`cp -a /etc/skel ${q(layout.home)} && chown -R ${u}:${u} ${q(layout.home)}`]),
    'fi; true',
  ].join('\n')
}

/**
 * Sets up a Linux VM reached over SSH for a harness session: the login user has passwordless
 * `sudo`, and the agent, setup steps and checks run as {@link SANDBOX_USER}, a user made here with
 * no `sudo` and none of the login user's groups or variables. Ports are reached through the
 * egress gateway's tunnel. When setting up fails, the connection is closed.
 */
export async function connectSsh(options: SshSessionOptions): Promise<SshMachine> {
  const { target, abortSignal: signal } = options
  const layout = options.layout ?? slotLayout(0)
  const userPath = [`${layout.home}/.local/bin`, ...(options.path ?? []), SYSTEM_PATH].join(':')
  const baseEnv = {
    PATH: userPath,
    HOME: layout.home,
    USER: layout.user,
    LOGNAME: layout.user,
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
  }
  const userEnv = {
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_PREFIX: `${layout.home}/.local`,
    ...options.env,
  }

  const hostRun: SessionShell['run'] = async (argv, o) => {
    const [bin = 'ssh', ...args] = argv
    const startedAt = Date.now()
    try {
      const r = await runHost(bin, args, { input: o.input ?? '', signal: o.signal, binary: true })
      traceDocker(args, startedAt, { ...r, stdin: o.input?.length ?? 0 }, 'ssh')
      return r
    } catch (error) {
      traceDocker(args, startedAt, { error }, 'ssh')
      throw error
    }
  }
  const ssh = (remote: string) => hostRun(sshArgv(target, remote), { input: '', signal })
  const closeConnection = async () => {
    if (!controlOptions(target.controlPath, 0).length) return
    const [bin = 'ssh', ...args] = sshArgv(target, '')
    await runHost(bin, ['-O', 'exit', ...args.slice(0, -1)]).catch(() => {})
  }
  const fail = async (error: unknown): Promise<never> => {
    await closeConnection()
    throw signal?.aborted ? signal.reason : error
  }

  const { user } = layout
  const setup = [
    EXEC_UMASK,
    ...(options.reset ? [`{ ${resetSlot(layout, options.reset.home)}\n}`] : []),
    `{ id -u ${user} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group ${user}; }`,
    `mkdir -p ${layout.root} && chown ${user}:${user} ${layout.root}`,
    // Slots sharing a machine are users of one host: neither reads the other's work.
    `chmod 700 ${layout.root} ${layout.home}`,
    `mkdir -p ${layout.state} && chown 0:0 ${layout.state} && chmod 700 ${layout.state}`,
    ...(options.prepare ? [options.prepare] : []),
  ].join(' && ')
  const asRoot = options.layout
    ? `sudo -n -- flock ${SETUP_LOCK} /bin/sh -c ${q(setup)}`
    : `sudo -n -- /bin/sh -c ${q(setup)}`
  let restored = false
  // A VM that just reported ready may not take SSH connections for a few seconds more.
  const deadline = Date.now() + (options.connectTimeoutMs ?? 60_000)
  for (let wait = 500; ; wait = Math.min(wait * 2, 5_000)) {
    const made = await ssh(asRoot).catch(fail)
    restored = made.stdout.toString('utf8').includes(RESTORED)
    if (made.exitCode === 0) break
    if (made.exitCode !== SSH_FAILED || Date.now() + wait > deadline) {
      const why = made.stderr.trim() || made.stdout.toString('utf8').trim()
      return fail(new Error(`Couldn't set up ${options.description}: ${why.slice(-500)}`))
    }
    await new Promise((resolve) => setTimeout(resolve, wait))
    if (signal?.aborted) return fail(signal.reason)
  }

  const shell = linuxShell({
    run: hostRun,
    remote: (command) => sshArgv(target, command),
    id: target.hostKeyAlias,
    user: baseEnv,
    signal,
    layout,
  })
  return {
    root: sshTransport(target),
    restored,
    async snapshotHome(label) {
      const file = snapshotFile(layout, label)
      const command = `${EXEC_UMASK} && mkdir -p ${q(posix.dirname(file))} && chmod 700 ${q(HOME_SNAPSHOTS)} && tar -C ${q(posix.dirname(layout.home))} -cf ${q(`${file}.tmp`)} ${q(posix.basename(layout.home))} && mv ${q(`${file}.tmp`)} ${q(file)}`
      const r = await ssh(`sudo -n -- /bin/sh -c ${q(command)}`)
      if (r.exitCode !== 0) {
        throw new Error(
          `Couldn't keep ${layout.user}'s home in ${options.description}: ${r.stderr.trim().slice(-500)}`,
        )
      }
    },
    close: closeConnection,
    session: ({ gateway, noGateway, destroy }) =>
      transportSession({
        id: target.hostKeyAlias,
        description: options.description,
        defaultWorkingDirectory: layout.root,
        shell,
        env: (env) => ({ ...userEnv, ...gateway?.env, ...env }),
        gateway,
        egress: gateway ? { active: true } : { active: false, reason: noGateway ?? '' },
        async portWithoutGateway(port) {
          throw new Error(
            `Port ${port} of ${options.description} isn't reachable: the egress gateway ${gateway?.stopped ? `stopped: ${gateway.stopped}` : "isn't running"}`,
          )
        },
        destroy,
      }),
  }
}
