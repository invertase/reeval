import type { Gateway } from './egress/gateway.ts'
import {
  controlOptions,
  type ExecTransport,
  type SshTarget,
  sshArgv,
  sshTransport,
} from './egress/transport.ts'
import { SANDBOX_HOME, SANDBOX_ROOT, SANDBOX_STATE, SANDBOX_USER } from './image.ts'
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
}

/** A Linux VM reeval set up over SSH, before its session: what the egress gateway starts on. */
export type SshMachine = {
  /** Runs the gateway's forwarder as root, over the session's connection. */
  root: ExecTransport
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

/**
 * Sets up a Linux VM reached over SSH for a harness session: the login user has passwordless
 * `sudo`, and the agent, setup steps and checks run as {@link SANDBOX_USER}, a user made here with
 * no `sudo` and none of the login user's groups or variables. Ports are reached through the
 * egress gateway's tunnel. When setting up fails, the connection is closed.
 */
export async function connectSsh(options: SshSessionOptions): Promise<SshMachine> {
  const { target, abortSignal: signal } = options
  const userPath = [`${SANDBOX_HOME}/.local/bin`, ...(options.path ?? []), SYSTEM_PATH].join(':')
  const baseEnv = {
    PATH: userPath,
    HOME: SANDBOX_HOME,
    USER: SANDBOX_USER,
    LOGNAME: SANDBOX_USER,
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

  const setup = [
    EXEC_UMASK,
    `id -u ${SANDBOX_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group ${SANDBOX_USER}`,
    `mkdir -p ${SANDBOX_ROOT} && chown ${SANDBOX_USER}:${SANDBOX_USER} ${SANDBOX_ROOT}`,
    `mkdir -p ${SANDBOX_STATE} && chown 0:0 ${SANDBOX_STATE} && chmod 700 ${SANDBOX_STATE}`,
    ...(options.prepare ? [options.prepare] : []),
  ].join(' && ')
  // A VM that just reported ready may not take SSH connections for a few seconds more.
  const deadline = Date.now() + (options.connectTimeoutMs ?? 60_000)
  for (let wait = 500; ; wait = Math.min(wait * 2, 5_000)) {
    const made = await ssh(`sudo -n -- /bin/sh -c ${q(setup)}`).catch(fail)
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
  })
  return {
    root: sshTransport(target),
    close: closeConnection,
    session: ({ gateway, noGateway, destroy }) =>
      transportSession({
        id: target.hostKeyAlias,
        description: options.description,
        defaultWorkingDirectory: SANDBOX_ROOT,
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
