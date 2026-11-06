import { type Gateway, startGateway } from './egress/gateway.ts'
import { isRestricted } from './egress/policy.ts'
import { controlOptions, type SshTarget, sshArgv, sshTransport } from './egress/transport.ts'
import { SANDBOX_HOME, SANDBOX_ROOT, SANDBOX_STATE, SANDBOX_USER } from './image.ts'
import { shellQuote as q, run as runHost } from './process.ts'
import {
  type DockerSession,
  type EgressOptions,
  type EgressStatus,
  EgressUnavailableError,
} from './session.ts'
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
  egress?: Omit<EgressOptions, 'direct'> | boolean
  /** Runs once the session's processes and connection are gone: deleting the VM. */
  onDestroy?: () => Promise<void>
}

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const EXEC_MARKER = 'REEVAL_EXEC_ID'
const EXEC_UMASK = 'umask 022'
/** ssh's own exit status: it couldn't connect, or the connection dropped. */
const SSH_FAILED = 255

/** `NAME=value\0` for each variable, as the remote reader takes them on stdin. */
const envStream = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}\0`)
    .join('')

/**
 * Runs `$2` with bash in `$1` as the sandbox user, after exporting the variables stdin carries.
 * The command itself gets no stdin, as a `docker exec` without `--interactive` would.
 */
const READER = `${EXEC_UMASK}; while IFS= read -r -d "" kv; do export "$kv"; done; cd -- "$1" || exit 1; exec bash -c "$2" </dev/null`

/**
 * A harness sandbox session on a Linux VM reached over SSH: the login user has passwordless `sudo`,
 * and the agent, setup steps and checks run as {@link SANDBOX_USER}, a user made here with no
 * `sudo` and none of the login user's groups or variables. Ports are reached through the egress
 * gateway's tunnel, so the session always asks for the gateway.
 */
export async function createSshSession(options: SshSessionOptions): Promise<DockerSession> {
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
  const ssh = (remote: string, input: string | Uint8Array = '', abort = signal) =>
    hostRun(sshArgv(target, remote), { input, signal: abort })
  const asUser = (cwd: string, command: string) =>
    `sudo -n -H -u ${SANDBOX_USER} -- env -i ${Object.entries(baseEnv)
      .map(([k, v]) => q(`${k}=${v}`))
      .join(' ')} bash -c ${q(READER)} bash ${q(cwd)} ${q(command)}`
  const asRoot = (command: string, marker?: string) =>
    `sudo -n -- env -i PATH=${SYSTEM_PATH} HOME=/root${marker ? ` ${EXEC_MARKER}=${marker}` : ''} /bin/sh -c ${q(`cd ${SANDBOX_STATE} || exit 1; ${EXEC_UMASK}; ${command}`)}`

  const closeConnection = async () => {
    if (!controlOptions(target.controlPath, 0).length) return
    const [bin = 'ssh', ...args] = sshArgv(target, '')
    await runHost(bin, ['-O', 'exit', ...args.slice(0, -1)]).catch(() => {})
  }
  let gateway: Gateway | undefined
  let destroyed: Promise<void> | undefined
  const destroy = () => {
    destroyed ??= (async () => {
      gateway?.close()
      await closeConnection()
      await options.onDestroy?.()
    })()
    return destroyed
  }
  const fail = async (error: unknown): Promise<never> => {
    await destroy().catch(() => {})
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

  const egressOptions = options.egress === true ? {} : options.egress || undefined
  let egress: EgressStatus | undefined
  if (egressOptions) {
    const { policy = { mode: 'allow-all' }, ...rest } = egressOptions
    try {
      gateway = await startGateway(sshTransport(target), { ...rest, policy }, signal)
      egress = { active: true }
    } catch (error) {
      // The VM keeps its own network, so only a restricted policy needs the gateway to be its way out.
      if (signal?.aborted || isRestricted(policy)) {
        await destroy().catch(() => {})
        if (signal?.aborted) throw signal.reason
        throw new EgressUnavailableError((error as Error).message)
      }
      egress = { active: false, reason: (error as Error).message }
    }
  }
  const envFor = (env?: Record<string, string>) => ({
    ...userEnv,
    ...(gateway ? gateway.env : {}),
    ...env,
  })

  /** Killing the host's ssh leaves the command running in the VM, so kill what has its marker. */
  const killExec = (marker: string) =>
    asRoot(
      `for e in /proc/[0-9]*/environ; do grep -qsxzF ${q(`${EXEC_MARKER}=${marker}`)} "$e" && kill -9 "$(basename "$(dirname "$e")")" 2>/dev/null; done; true`,
    )
  const marker = (exec: number) => `${target.hostKeyAlias}-${exec}`
  const shell: SessionShell = {
    run: hostRun,
    user: ({ command, cwd, env, exec }) => ({
      argv: sshArgv(target, asUser(cwd, command)),
      input: envStream({ ...env, [EXEC_MARKER]: marker(exec) }),
    }),
    privileged: ({ command, exec }) => ({
      argv: sshArgv(target, asRoot(command, marker(exec))),
      input: '',
    }),
    kill: (exec) => ({ argv: sshArgv(target, killExec(marker(exec))), input: '' }),
    direct: (argv) => sshArgv(target, `sudo -n -u ${SANDBOX_USER} -- ${argv.map(q).join(' ')}`),
  }

  return transportSession({
    id: target.hostKeyAlias,
    description: options.description,
    defaultWorkingDirectory: SANDBOX_ROOT,
    shell,
    env: envFor,
    gateway,
    egress,
    async portWithoutGateway(port) {
      throw new Error(
        `Port ${port} of ${options.description} isn't reachable: the egress gateway ${gateway?.stopped ? `stopped: ${gateway.stopped}` : "isn't running"}`,
      )
    },
    destroy,
  })
}
