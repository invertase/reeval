import { spawn } from 'node:child_process'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from '@ai-sdk/harness'
import { docker, dockerOk, removeContainerDetached } from './docker-cli.ts'
import { type Gateway, type GatewayOptions, startGateway } from './egress/gateway.ts'
import { isRestricted, type NetworkPolicy } from './egress/policy.ts'
import { BRIDGE_PORT, LABEL, SANDBOX_ROOT } from './image.ts'

/** Starts the egress gateway: credential brokering, and an enforceable network policy. */
export type EgressOptions = Omit<GatewayOptions, 'policy'> & {
  /** Defaults to `allow-all`. Anything else detaches the container from every Docker network. */
  policy?: NetworkPolicy
}

export type SessionOptions = {
  image: string
  labels?: Record<string, string>
  /** Set in the container for every process; values travel via the docker CLI's env, not argv. */
  env?: Record<string, string>
  /** The container removes itself after this long, as a backstop for hard-killed runs. */
  lifetimeMs?: number
  abortSignal?: AbortSignal
  egress?: EgressOptions | boolean
}

/** Whether the gateway runs. When it doesn't, the session has no request-transformation methods. */
export type EgressStatus = { active: true } | { active: false; reason: string }

export type DockerSession = HarnessV1NetworkSandboxSession & {
  /** Unset when the session wasn't asked to start the gateway. */
  readonly egress?: EgressStatus
}

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** Set on every exec, so a kill can find the command's whole process tree in the container. */
const EXEC_MARKER = 'ES_EXEC_ID'

/** The Docker networks a container is attached to. */
async function networksOf(id: string): Promise<string[]> {
  const out = await dockerOk(['inspect', '--format', '{{json .NetworkSettings.Networks}}', id])
  return Object.keys(JSON.parse(out) ?? {})
}

/**
 * A harness sandbox session backed by one local Docker container. Commands and file I/O go
 * through `docker exec`. With the egress gateway, ports are reached through its tunnel whatever
 * the network policy; without it, the bridge port is published on 127.0.0.1.
 */
export async function createDockerSession(options: SessionOptions): Promise<DockerSession> {
  const labels = { [LABEL.managed]: 'true', ...options.labels }
  const lifetime = Math.ceil((options.lifetimeMs ?? 24 * 3_600_000) / 1000)
  const signal = options.abortSignal
  const id = await dockerOk(
    [
      'run',
      '--detach',
      '--rm',
      '--init',
      ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      ...Object.keys(options.env ?? {}).flatMap((k) => ['--env', k]),
      '--publish',
      `127.0.0.1::${BRIDGE_PORT}`,
      '--workdir',
      SANDBOX_ROOT,
      '--entrypoint',
      'sleep',
      options.image,
      String(lifetime),
    ],
    { signal, env: options.env },
  )
  let gateway: Gateway | undefined
  let removed: Promise<void> | undefined
  const remove = () => {
    gateway?.close()
    removed ??= removeContainerDetached(id)
    return removed
  }
  if (signal?.aborted) {
    await remove()
    throw signal.reason
  }

  const egressOptions = options.egress === true ? {} : options.egress || undefined
  let egress: EgressStatus | undefined
  // Networks the container was detached from, to reattach if the policy opens up again.
  let detached: string[] = []
  const attach = async (policy: NetworkPolicy) => {
    if (isRestricted(policy) && detached.length === 0) {
      detached = await networksOf(id)
      for (const n of detached) await dockerOk(['network', 'disconnect', '--force', n, id])
    } else if (!isRestricted(policy) && detached.length > 0) {
      for (const n of detached) await dockerOk(['network', 'connect', n, id])
      detached = []
    }
  }
  if (egressOptions) {
    const { policy = { mode: 'allow-all' }, ...rest } = egressOptions
    try {
      // Before anything but `sleep` runs, so a restricted container never has a route out.
      await attach(policy)
      gateway = await startGateway(id, { ...rest, policy }, signal)
      egress = { active: true }
    } catch (error) {
      if (signal?.aborted || isRestricted(policy)) {
        await remove()
        if (signal?.aborted) throw signal.reason
        throw new Error(`Can't enforce the egress policy: ${(error as Error).message}`)
      }
      egress = { active: false, reason: (error as Error).message }
    }
  }
  const envFor = (env?: Record<string, string>) => (gateway ? { ...gateway.env, ...env } : env)

  let execs = 0
  const execArgs = (
    command: string,
    marker: string,
    cwd?: string,
    env?: Record<string, string>,
  ) => [
    'exec',
    '--interactive',
    '--workdir',
    cwd ? posix.resolve(SANDBOX_ROOT, cwd) : SANDBOX_ROOT,
    '--env',
    `${EXEC_MARKER}=${marker}`,
    ...Object.keys(env ?? {}).flatMap((k) => ['--env', k]),
    id,
    'bash',
    '-c',
    command,
  ]
  const nextMarker = () => `${id.slice(0, 12)}-${++execs}`
  /**
   * Killing the host's `docker exec` client doesn't stop the command in the container, so kill
   * every process there that inherited this exec's marker: the command and all it started.
   */
  const killExec = (marker: string) =>
    docker([
      'exec',
      id,
      'sh',
      '-c',
      `for e in /proc/[0-9]*/environ; do grep -qsxzF ${q(`${EXEC_MARKER}=${marker}`)} "$e" && kill -9 "$(basename "$(dirname "$e")")" 2>/dev/null; done; true`,
    ]).then(
      () => {},
      () => {},
    )

  const run: HarnessV1NetworkSandboxSession['run'] = async (o) => {
    const env = envFor(o.env)
    const marker = nextMarker()
    try {
      const r = await docker(execArgs(o.command, marker, o.workingDirectory, env), {
        env,
        signal: o.abortSignal,
      })
      return { exitCode: r.exitCode, stdout: r.stdout.toString('utf8'), stderr: r.stderr }
    } catch (error) {
      if (o.abortSignal?.aborted) await killExec(marker)
      throw error
    }
  }

  const readBinaryFile = async (o: { path: string; abortSignal?: AbortSignal }) => {
    const r = await docker(['exec', id, 'cat', '--', posix.resolve(SANDBOX_ROOT, o.path)], {
      signal: o.abortSignal,
    })
    return r.exitCode === 0 ? new Uint8Array(r.stdout) : null
  }

  const writeBinaryFile = async (o: {
    path: string
    content: Uint8Array
    abortSignal?: AbortSignal
  }) => {
    const path = posix.resolve(SANDBOX_ROOT, o.path)
    await dockerOk(
      [
        'exec',
        '--interactive',
        id,
        'sh',
        '-c',
        `mkdir -p ${q(posix.dirname(path))} && cat > ${q(path)}`,
      ],
      { input: Buffer.from(o.content), signal: o.abortSignal },
    )
  }

  const brokering: Partial<HarnessV1NetworkSandboxSession> = gateway
    ? {
        async setNetworkPolicy(policy) {
          gateway?.setPolicy(policy)
          await attach(policy)
        },
        async addRequestTransformations(rules) {
          gateway?.addTransformations(rules)
        },
        async setRequestTransformations(rules) {
          gateway?.setTransformations(rules)
        },
      }
    : {}

  const session: DockerSession = {
    id,
    description: `Docker container ${id.slice(0, 12)} (${options.image})`,
    defaultWorkingDirectory: SANDBOX_ROOT,
    ports: [BRIDGE_PORT],
    ...(egress ? { egress } : {}),
    ...brokering,
    run,
    async spawn(o) {
      const env = envFor(o.env)
      const marker = nextMarker()
      const child = spawn('docker', execArgs(o.command, marker, o.workingDirectory, env), {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: env ? { ...process.env, ...env } : process.env,
      })
      const exited = new Promise<{ exitCode: number }>((resolve) =>
        child.on('close', (code) => resolve({ exitCode: code ?? 1 })),
      )
      const kill = async () => {
        child.kill('SIGKILL')
        await killExec(marker)
      }
      o.abortSignal?.addEventListener('abort', () => void kill(), { once: true })
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill,
      }
    },
    readBinaryFile,
    async readFile(o) {
      const bytes = await readBinaryFile(o)
      return bytes === null
        ? null
        : (Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>)
    },
    async readTextFile(o) {
      const bytes = await readBinaryFile(o)
      if (bytes === null) return null
      const text = Buffer.from(bytes).toString('utf8')
      if (o.startLine === undefined && o.endLine === undefined) return text
      return text
        .split('\n')
        .slice((o.startLine ?? 1) - 1, o.endLine)
        .join('\n')
    },
    writeBinaryFile,
    writeTextFile: (o) => writeBinaryFile({ ...o, content: Buffer.from(o.content, 'utf8') }),
    async writeFile(o) {
      const chunks: Uint8Array[] = []
      for await (const chunk of o.content) chunks.push(chunk)
      await writeBinaryFile({ ...o, content: Buffer.concat(chunks) })
    },
    async getPortEndpoint({ port, protocol = 'ws' }) {
      const scheme = protocol === 'ws' ? 'ws' : 'http'
      // The tunnel doesn't depend on the container's networks, which a policy change detaches
      // and reattaches, and Docker Desktop drops published ports on reattach.
      if (gateway) return { url: await gateway.portUrl(port, scheme) }
      const mapped = await docker(['port', id, `${port}/tcp`])
      const hostPort = mapped.stdout.toString('utf8').split('\n')[0]?.split(':').at(-1)
      if (mapped.exitCode !== 0 || !hostPort) {
        const reason = mapped.stderr.trim() || 'Docker reports no host port for it'
        throw new Error(`Port ${port} of ${id.slice(0, 12)} isn't reachable: ${reason}`)
      }
      return { url: `${scheme}://127.0.0.1:${hostPort}` }
    },
    async getPortUrl(o) {
      return (await session.getPortEndpoint(o)).url
    },
    stop: remove,
    destroy: remove,
    restricted: () => {
      const { description, readFile, readBinaryFile, readTextFile, writeFile } = session
      const { writeBinaryFile, writeTextFile, spawn, run } = session
      return {
        description,
        readFile,
        readBinaryFile,
        readTextFile,
        writeFile,
        writeBinaryFile,
        writeTextFile,
        spawn,
        run,
      }
    },
  }
  return session
}

/** The session as an AI SDK harness sandbox provider. */
export const dockerSandboxProvider = (options: SessionOptions): HarnessV1SandboxProvider => ({
  specificationVersion: 'harness-sandbox-v1',
  providerId: 'evalsuite-docker',
  async createSession(o) {
    const session = await createDockerSession({ ...options, abortSignal: o?.abortSignal })
    await o?.onFirstCreate?.(session, { abortSignal: o.abortSignal })
    return session
  },
})
