import { spawn } from 'node:child_process'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from '@ai-sdk/harness'
import { docker, dockerOk, removeContainerDetached } from './docker-cli.ts'
import { BRIDGE_PORT, LABEL, SANDBOX_ROOT } from './image.ts'

type SessionOptions = {
  image: string
  labels?: Record<string, string>
  /** The container removes itself after this long, as a backstop for hard-killed runs. */
  lifetimeMs?: number
  abortSignal?: AbortSignal
}

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * A harness sandbox session backed by one local Docker container. Commands and file I/O go
 * through `docker exec`; the bridge port is published on 127.0.0.1.
 */
export async function createDockerSession(
  options: SessionOptions,
): Promise<HarnessV1NetworkSandboxSession> {
  const labels = { [LABEL.managed]: 'true', ...options.labels }
  const lifetime = Math.ceil((options.lifetimeMs ?? 24 * 3_600_000) / 1000)
  const id = await dockerOk(
    [
      'run',
      '--detach',
      '--rm',
      '--init',
      ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      '--publish',
      `127.0.0.1::${BRIDGE_PORT}`,
      '--workdir',
      SANDBOX_ROOT,
      '--entrypoint',
      'sleep',
      options.image,
      String(lifetime),
    ],
    { signal: options.abortSignal },
  )
  let removed: Promise<void> | undefined
  const remove = () => {
    removed ??= removeContainerDetached(id)
    return removed
  }
  if (options.abortSignal?.aborted) {
    await remove()
    throw options.abortSignal.reason
  }

  const execArgs = (command: string, cwd?: string, env?: Record<string, string>) => [
    'exec',
    '--interactive',
    '--workdir',
    cwd ? posix.resolve(SANDBOX_ROOT, cwd) : SANDBOX_ROOT,
    ...Object.keys(env ?? {}).flatMap((k) => ['--env', k]),
    id,
    'bash',
    '-c',
    command,
  ]

  const run: HarnessV1NetworkSandboxSession['run'] = async (o) => {
    const r = await docker(execArgs(o.command, o.workingDirectory, o.env), {
      env: o.env,
      signal: o.abortSignal,
    })
    return { exitCode: r.exitCode, stdout: r.stdout.toString('utf8'), stderr: r.stderr }
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

  const session: HarnessV1NetworkSandboxSession = {
    id,
    description: `Docker container ${id.slice(0, 12)} (${options.image})`,
    defaultWorkingDirectory: SANDBOX_ROOT,
    ports: [BRIDGE_PORT],
    run,
    async spawn(o) {
      const child = spawn('docker', execArgs(o.command, o.workingDirectory, o.env), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: o.env ? { ...process.env, ...o.env } : process.env,
      })
      const exited = new Promise<{ exitCode: number }>((resolve) =>
        child.on('close', (code) => resolve({ exitCode: code ?? 1 })),
      )
      o.abortSignal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => exited,
        async kill() {
          child.kill('SIGKILL')
        },
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
      const mapped = await dockerOk(['port', id, `${port}/tcp`])
      const hostPort = mapped.split('\n')[0]?.split(':').at(-1)
      return { url: `${protocol === 'ws' ? 'ws' : 'http'}://127.0.0.1:${hostPort}` }
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

export const dockerSandboxProvider = (options: SessionOptions): HarnessV1SandboxProvider => ({
  specificationVersion: 'harness-sandbox-v1',
  providerId: 'evalsuite-docker',
  async createSession(o) {
    const session = await createDockerSession({ ...options, abortSignal: o?.abortSignal })
    await o?.onFirstCreate?.(session, { abortSignal: o.abortSignal })
    return session
  },
})
