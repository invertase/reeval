import { type ChildProcess, spawn } from 'node:child_process'
import { posix } from 'node:path'
import type { Gateway } from './egress/gateway.ts'
import {
  controlOptions,
  type ExecTransport,
  type SshTarget,
  sshArgv,
  sshTransport,
} from './egress/transport.ts'
import { SANDBOX_HOME, SANDBOX_USER, type SlotLayout, slotLayout } from './image.ts'
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
   * any slot, is copied in; else this slot takes the install's lock, which the machine's other
   * slots wait on rather than install too.
   */
  home?: string
}

/** A Linux VM reeval set up over SSH, before its session: what the egress gateway starts on. */
export type SshMachine = {
  /** Runs the gateway's forwarder as root, over the session's connection. */
  root: ExecTransport
  /**
   * Gives the sandbox user the machine's home for `home`, waiting while another slot installs it:
   * `restored` once it's in place, false when this slot is to install it. `copyFailed` says why
   * the machine's copy wouldn't unpack, when this slot installs because of it.
   */
  home(): Promise<{ restored: boolean; waitedMs: number; copyFailed?: string }>
  /**
   * Keeps the sandbox user's home as it is now as the machine's copy under `home`, for its other
   * slots and later resets, when this slot holds the install's lock, and lets the slots waiting
   * for it go on.
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
  /** Releases an install's lock it still holds, then closes the shared SSH connection. */
  close(): Promise<void>
}

/** ssh's own exit status: it couldn't connect, or the connection dropped. */
const SSH_FAILED = 255
/** Held while one slot sets up, so slots sharing a machine don't install the same things at once. */
const SETUP_LOCK = '/var/lock/reeval-setup'
/** The machine's homes, root's: `home-<label>.tar`, and the `.lock` its installer holds. */
const HOMES = '/var/lib/reeval-pool'
const RESTORED = 'reeval:home-restored'
const CLAIMED = 'reeval:install-claimed'
const WAITING = 'reeval:install-waiting'
const COPY_FAILED = 'reeval:home-copy-failed'
const FRESH = 'reeval:install-fresh'
/** How long a slot waits for another's install, past the install's own deadline of 10 minutes. */
const INSTALL_WAIT_MS = 11 * 60_000

const homeFiles = (label: string) => {
  const base = `${HOMES}/home-${label.replace(/[^A-Za-z0-9._-]/g, '_')}`
  return { tar: `${base}.tar`, lock: `${base}.lock` }
}

/**
 * Root commands that empty a slot's home back to the skeleton. The directory itself stays: on a
 * shared machine, slot 0's is where the other slots' commands see their own homes.
 */
const skeletonHome = (layout: SlotLayout) => {
  const [u, home] = [q(layout.user), q(layout.home)]
  return `mkdir -p ${home} && find ${home} -mindepth 1 -delete && cp -a /etc/skel/. ${home}/ && chown -R -h ${u}:${u} ${home} && chmod 700 ${home}`
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
    `rm -rf ${q(layout.root)} ${q(layout.state)}`,
    skeletonHome(layout),
    'fi; true',
  ].join('\n')
}

/**
 * The root script that gives a slot the machine's home for `label`. With a copy kept, it unpacks
 * it into the slot's home ({@link RESTORED}): every slot sees its home at one path, so the copy
 * needs no change. With none, the slot takes the install's lock and holds it, in the process that
 * then reads its stdin until the installer closes it ({@link CLAIMED}); a slot that finds it held
 * says {@link WAITING} and blocks until the kernel releases it, when its holder finishes or dies.
 * A copy that won't unpack is deleted ({@link COPY_FAILED}) and the slot goes for the lock again,
 * or installs on its own ({@link FRESH}).
 */
function slotHome(layout: SlotLayout, label: string): string {
  const f = homeFiles(label)
  const [tar, lock] = [q(f.tar), q(f.lock)]
  const [u, home] = [q(layout.user), q(layout.home)]
  const restore = `find ${home} -mindepth 1 -delete && tar -C ${home} --strip-components=1 -xpf ${tar} && chown -R -h ${u}:${u} ${home} && chmod 700 ${home}`
  return [
    `mkdir -p ${q(HOMES)} && chmod 700 ${q(HOMES)} && exec 9>>${lock} || exit 1`,
    'for try in 1 2; do',
    `if [ ! -f ${tar} ] && ! flock -x -n 9; then echo ${WAITING}; flock -x -w ${INSTALL_WAIT_MS / 1000} 9 || { echo "another slot was still installing the harness after ${INSTALL_WAIT_MS / 60_000} minutes" >&2; exit 1; }; fi`,
    `if [ ! -f ${tar} ]; then echo ${CLAIMED}; exec cat >/dev/null; fi`,
    'flock -u 9',
    `if ${restore}; then echo ${RESTORED}; exit 0; fi`,
    `echo ${COPY_FAILED}; rm -f ${tar}; ${skeletonHome(layout)} || exit 1`,
    'done',
    `echo ${FRESH}`,
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
  const userPath = [`${SANDBOX_HOME}/.local/bin`, ...(options.path ?? []), SYSTEM_PATH].join(':')
  const baseEnv = {
    PATH: userPath,
    HOME: SANDBOX_HOME,
    USER: layout.user,
    LOGNAME: layout.user,
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
  }
  const userEnv = {
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_PREFIX: `${SANDBOX_HOME}/.local`,
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
  const addUser = (name: string) =>
    `{ id -u ${name} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group ${name}; }`
  const setup = [
    EXEC_UMASK,
    ...(options.reset ? [`{ ${resetSlot(layout)}\n}`] : []),
    ...(layout.home === SANDBOX_HOME
      ? [addUser(user)]
      : [
          // Its commands see its home where slot 0's is, which must be there to bind it over.
          addUser(SANDBOX_USER),
          `chmod 700 ${SANDBOX_HOME}`,
          `{ id -u ${user} >/dev/null 2>&1 || useradd --no-create-home --home-dir ${SANDBOX_HOME} --shell /bin/bash --user-group ${user}; }`,
          `{ [ -d ${layout.home} ] || { cp -a /etc/skel ${layout.home} && chown -R ${user}:${user} ${layout.home}; }; }`,
        ]),
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

  /** The process holding the install's lock in the machine, while this slot installs. */
  let holder: ChildProcess | undefined
  const release = async () => {
    const held = holder
    holder = undefined
    if (!held || held.exitCode !== null) return
    const gone = new Promise((resolve) => held.once('close', resolve))
    held.stdin?.end()
    const timer = setTimeout(() => held.kill('SIGKILL'), 10_000)
    await gone
    clearTimeout(timer)
  }

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
      const [bin = 'ssh', ...args] = sshArgv(
        target,
        `sudo -n -- /bin/sh -c ${q(`${EXEC_UMASK}\n${slotHome(layout, options.home)}`)}`,
      )
      const startedAt = Date.now()
      const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let [out, err] = ['', '']
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString('utf8')
      })
      const said = await new Promise<string>((resolve, reject) => {
        let waitingSince: number | undefined
        const stop = () => child.kill('SIGKILL')
        signal?.addEventListener('abort', stop, { once: true })
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString('utf8')
          if (waitingSince === undefined && out.includes(WAITING)) waitingSince = Date.now()
          const decided = [RESTORED, CLAIMED, FRESH].find((m) => out.includes(m))
          if (!decided) return
          signal?.removeEventListener('abort', stop)
          resolve(`${decided} ${waitingSince === undefined ? 0 : Date.now() - waitingSince}`)
        })
        child.once('error', reject)
        child.once('close', (code) => {
          signal?.removeEventListener('abort', stop)
          if (signal?.aborted) return reject(signal.reason)
          const why = err.trim() || out.trim() || `ssh exited with ${code}`
          reject(
            new Error(
              `Couldn't give ${user} the machine's home in ${options.description}: ${why.slice(-500)}`,
            ),
          )
        })
      }).finally(() =>
        traceDocker(args, startedAt, { exitCode: child.exitCode, stdout: out, stderr: err }, 'ssh'),
      )
      const [decided, waited] = said.split(' ')
      if (decided === CLAIMED) holder = child
      else child.stdin.end()
      return {
        restored: decided === RESTORED,
        waitedMs: Number(waited),
        ...(out.includes(COPY_FAILED) && {
          copyFailed: err.trim().slice(-500) || "the machine's copy didn't unpack",
        }),
      }
    },
    async snapshotHome() {
      if (!options.home || !holder) return
      const f = homeFiles(options.home)
      const command = [
        EXEC_UMASK,
        `tar -C ${q(posix.dirname(layout.home))} -cf ${q(f.tar)}.$$ ${q(posix.basename(layout.home))}`,
        `mv ${q(f.tar)}.$$ ${q(f.tar)}`,
      ].join(' && ')
      try {
        const r = await ssh(`sudo -n -- /bin/sh -c ${q(command)}`)
        if (r.exitCode !== 0) {
          throw new Error(
            `Couldn't keep ${layout.user}'s home in ${options.description}: ${r.stderr.trim().slice(-500)}`,
          )
        }
      } finally {
        await release()
      }
    },
    async close() {
      // An install that never finished lets a waiting slot install instead.
      await release()
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
