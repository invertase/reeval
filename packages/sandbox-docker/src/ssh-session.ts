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
  /** The slot ran an attempt before: kill what its user left running and delete its files. */
  reset?: boolean
  /**
   * The install the sandbox user's home needs, by label: a home the machine kept under it, from
   * any slot, is copied in; else this slot claims the install, which the machine's other slots
   * wait for rather than run too.
   */
  home?: string
}

/** A Linux VM reeval set up over SSH, before its session: what the egress gateway starts on. */
export type SshMachine = {
  /** Runs the gateway's forwarder as root, over the session's connection. */
  root: ExecTransport
  /**
   * Gives the sandbox user the machine's home for `home`, waiting while another slot installs it:
   * `restored` once it's in place, false when this slot is to install it.
   */
  home(): Promise<{ restored: boolean; waitedMs: number }>
  /**
   * Keeps the sandbox user's home as it is now as the machine's copy under `home`, for its other
   * slots and later resets, and lets the slots waiting for the install go on.
   */
  snapshotHome(): Promise<void>
  /**
   * The VM as a harness session, on `gateway` when it started (or with why it didn't). Its
   * `destroy` is the caller's: close the gateway, then {@link SshMachine.close}, then the VM.
   */
  session(o: {
    gateway: Gateway | undefined
    noGateway: string | undefined
    destroy: () => Promise<void>
  }): DockerSession
  /** Hands on an install claim it never finished, then closes the shared SSH connection. */
  close(): Promise<void>
}

/** ssh's own exit status: it couldn't connect, or the connection dropped. */
const SSH_FAILED = 255
/** Held while one slot sets up, so slots sharing a machine don't install the same things at once. */
const SETUP_LOCK = '/var/lock/reeval-setup'
/** The machine's homes, root's: `home-<label>.tar`, with the home it was taken from in `.from`. */
const HOMES = '/var/lib/reeval-pool'
const RESTORED = 'reeval:home-restored'
const CLAIMED = 'reeval:install-claimed'
const WAITING = 'reeval:install-waiting'
/** How long a slot waits for another's install, past the install's own deadline of 10 minutes. */
const INSTALL_WAIT_MS = 11 * 60_000

const homeFiles = (label: string) => {
  const base = `${HOMES}/home-${label.replace(/[^A-Za-z0-9._-]/g, '_')}`
  return { tar: `${base}.tar`, from: `${base}.from`, claim: `${base}.claim` }
}

/**
 * Root commands that put a used slot back as a new one finds it: none of its user's processes,
 * cron or at jobs, lingering, temporary files, locks or message queues, an empty working root and
 * state directory, and the skeleton home.
 */
export function resetSlot(layout: SlotLayout): string {
  const u = q(layout.user)
  return [
    `if id -u ${u} >/dev/null 2>&1; then`,
    `for i in 1 2 3 4 5 6 7 8 9 10; do pkill -KILL -u ${u} || break; sleep 0.2; done`,
    `crontab -r -u ${u} 2>/dev/null`,
    `atq 2>/dev/null | awk -v u=${u} '$NF == u { print $1 }' | xargs -r atrm 2>/dev/null`,
    `loginctl disable-linger ${u} 2>/dev/null`,
    `find /tmp /var/tmp /dev/shm /run/lock /dev/mqueue -xdev -mindepth 1 -user ${u} -delete 2>/dev/null`,
    `rm -rf ${q(layout.root)} ${q(layout.state)} ${q(layout.home)}`,
    `cp -a /etc/skel ${q(layout.home)} && chown -R ${u}:${u} ${q(layout.home)}`,
    'fi; true',
  ].join('\n')
}

/**
 * The root command that gives a slot the machine's home for `label`: the copy, moved into the
 * slot's home with every path to the home it was taken from pointed at this one (printing
 * {@link RESTORED}); else the claim to install it ({@link CLAIMED}), taken from a slot that has
 * held it past {@link INSTALL_WAIT_MS}; else {@link WAITING} while another slot installs.
 */
function slotHome(layout: SlotLayout, label: string): string {
  const f = homeFiles(label)
  const [tar, from, claim] = [q(f.tar), q(f.from), q(f.claim)]
  const u = q(layout.user)
  const home = q(layout.home)
  // Slot homes differ only in their last name, and no name may follow on from the old one.
  const rewrite = `s#$src\\([^A-Za-z0-9._-]\\|$\\)#${layout.home}\\1#g`
  const restore = [
    `src=$(cat ${from})`,
    `tmp=$(mktemp -d ${q(`${posix.dirname(layout.home)}/.reeval-home-XXXXXX`)})`,
    `tar -C "$tmp" -xpf ${tar}`,
    `rm -rf ${home}`,
    `mv "$tmp/$(basename "$src")" ${home}`,
    'rmdir "$tmp"',
    `{ [ "$src" = ${home} ] || { grep -rlI --null -F -- "$src" ${home} | xargs -0 -r sed -i "${rewrite}" && find ${home} -type l \\( -lname "$src" -o -lname "$src/*" \\) -exec sh -c 't=$(readlink "$1"); ln -sfn "$2${'$'}{t#"$3"}" "$1"' sh {} ${home} "$src" \\; ; }; }`,
    `chown -R -h ${u}:${u} ${home}`,
    `chmod 700 ${home}`,
    `echo ${RESTORED}`,
  ].join(' && ')
  const stale = Math.ceil(INSTALL_WAIT_MS / 60_000)
  return [
    `mkdir -p ${q(HOMES)} && chmod 700 ${q(HOMES)} &&`,
    `if [ -f ${tar} ]; then ${restore}`,
    `elif mkdir ${claim} 2>/dev/null; then echo ${CLAIMED}`,
    `elif [ -n "$(find ${claim} -maxdepth 0 -mmin +${stale} 2>/dev/null)" ] && rm -rf ${claim} && mkdir ${claim} 2>/dev/null; then echo ${CLAIMED}`,
    `else echo ${WAITING}; fi`,
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
    ...(options.reset ? [`{ ${resetSlot(layout)}\n}`] : []),
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
  // A VM that just reported ready may not take SSH connections for a few seconds more.
  const deadline = Date.now() + (options.connectTimeoutMs ?? 60_000)
  for (let wait = 500; ; wait = Math.min(wait * 2, 5_000)) {
    const made = await ssh(asRoot).catch(fail)
    if (made.exitCode === 0) break
    if (made.exitCode !== SSH_FAILED || Date.now() + wait > deadline) {
      const why = made.stderr.trim() || made.stdout.toString('utf8').trim()
      return fail(new Error(`Couldn't set up ${options.description}: ${why.slice(-500)}`))
    }
    await new Promise((resolve) => setTimeout(resolve, wait))
    if (signal?.aborted) return fail(signal.reason)
  }

  let claimed = false

  const shell = linuxShell({
    run: hostRun,
    remote: (command) => sshArgv(target, command),
    // Slots on one machine number their commands alike, so the marker kill finds names the slot.
    id: `${target.hostKeyAlias}-${layout.user}`,
    user: baseEnv,
    signal,
    layout,
  })
  return {
    root: sshTransport(target),
    // Outside the setup lock: slots copy the machine's home at once, and wait while one installs.
    async home() {
      if (!options.home) return { restored: false, waitedMs: 0 }
      const command = `sudo -n -- /bin/sh -c ${q(`${EXEC_UMASK} && ${slotHome(layout, options.home)}`)}`
      const until = Date.now() + INSTALL_WAIT_MS
      let waitingSince: number | undefined
      for (;;) {
        signal?.throwIfAborted()
        const asked = Date.now()
        const r = await ssh(command)
        const said = r.stdout.toString('utf8')
        if (r.exitCode !== 0) {
          const why = r.stderr.trim() || said.trim()
          throw new Error(
            `Couldn't give ${user} the machine's home in ${options.description}: ${why.slice(-500)}`,
          )
        }
        if (!said.includes(WAITING)) {
          claimed = said.includes(CLAIMED)
          const waitedMs = waitingSince === undefined ? 0 : asked - waitingSince
          return { restored: said.includes(RESTORED), waitedMs }
        }
        waitingSince ??= asked
        if (Date.now() > until) {
          throw new Error(
            `Another slot of ${options.description} was still installing the harness after ${INSTALL_WAIT_MS / 60_000} minutes`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    },
    async snapshotHome() {
      if (!options.home) return
      const f = homeFiles(options.home)
      const parent = q(posix.dirname(layout.home))
      const command = [
        EXEC_UMASK,
        `mkdir -p ${q(HOMES)}`,
        `chmod 700 ${q(HOMES)}`,
        `tar -C ${parent} -cf ${q(f.tar)}.$$ ${q(posix.basename(layout.home))}`,
        `printf %s ${q(layout.home)} > ${q(f.from)}.$$`,
        `mv ${q(f.from)}.$$ ${q(f.from)}`,
        `mv ${q(f.tar)}.$$ ${q(f.tar)}`,
        `rm -rf ${q(f.claim)}`,
      ].join(' && ')
      const r = await ssh(`sudo -n -- /bin/sh -c ${q(command)}`)
      if (r.exitCode !== 0) {
        throw new Error(
          `Couldn't keep ${layout.user}'s home in ${options.description}: ${r.stderr.trim().slice(-500)}`,
        )
      }
      claimed = false
    },
    async close() {
      // An install that never finished hands its claim on, so a waiting slot installs instead.
      if (claimed && options.home) {
        await ssh(`sudo -n -- rm -rf ${q(homeFiles(options.home).claim)}`).catch(() => {})
      }
      await closeConnection()
    },
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
