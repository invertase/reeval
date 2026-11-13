import { spawn } from 'node:child_process'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { Gateway } from './egress/gateway.ts'
import type { NetworkPolicy } from './egress/policy.ts'
import { BRIDGE_PORT } from './image.ts'
import { type RunResult, unsetOtel } from './process.ts'
import { type DockerSession, type EgressStatus, pathOperations } from './session.ts'
import { traceDocker } from './trace.ts'

/** A host program and what goes on its stdin. */
export type HostCommand = { argv: string[]; input: string | Uint8Array }

/**
 * How a machine's commands run, as host programs: the part of a session that differs between
 * machines. `exec` numbers each command, so {@link SessionShell.kill} can find what it started.
 */
export type SessionShell = {
  /** Runs a host program to its end, into the attempt's trace. */
  run(
    argv: readonly string[],
    o: { input?: string | Uint8Array; signal?: AbortSignal | undefined },
  ): Promise<RunResult<Buffer>>
  /** Runs `command` with bash as the agent's user in `cwd`, with `env` and an empty stdin. */
  user(o: { command: string; cwd: string; env: Record<string, string>; exec: number }): HostCommand
  /** Runs one of reeval's own commands where the agent's user can't interfere, without its variables. */
  privileged(o: { command: string; exec: number }): HostCommand
  /** Kills what command `exec` started, everything under it included. */
  kill(exec: number): HostCommand
  /** Runs `argv` as the agent's user with its stdin piped: file reads, writes and path scripts. */
  direct(argv: readonly string[]): string[]
}

export type TransportSessionOptions = {
  id: string
  /** How messages name the machine: `tart VM reeval-…`. */
  description: string
  /** How a failed write names the machine: the VM's name, or {@link description} when unset. */
  name?: string
  /** Where a relative path or working directory is. */
  defaultWorkingDirectory: string
  shell: SessionShell
  /** Every agent process's variables, with a command's own `extra` over them. */
  env(extra?: Record<string, string>): Record<string, string>
  gateway: Gateway | undefined
  /** The egress status while the gateway hasn't stopped; unset when it wasn't asked for. */
  egress: EgressStatus | undefined
  /** A port's URL when there's no running gateway to tunnel to it: another way, or a refusal. */
  portWithoutGateway(port: number, scheme: 'ws' | 'http'): Promise<string>
  destroy(): Promise<void>
}

/** How long killing an aborted command may take. */
const KILL_TIMEOUT_MS = 30_000

const text = (r: RunResult<Buffer>) => ({
  exitCode: r.exitCode,
  stdout: r.stdout.toString('utf8'),
  stderr: r.stderr,
})

/**
 * A harness sandbox session on a machine reeval reaches through host programs (`ssh`, `tart
 * exec`): everything but how a command gets there, which {@link SessionShell} says.
 */
export function transportSession(o: TransportSessionOptions): DockerSession {
  const { shell, gateway, description } = o
  let execs = 0
  const at = (path?: string) =>
    path ? posix.resolve(o.defaultWorkingDirectory, path) : o.defaultWorkingDirectory
  const runHost = (c: HostCommand, signal?: AbortSignal) =>
    shell.run(c.argv, { input: c.input, signal })
  // The kill has a signal of its own: the one that aborted the command would stop it before it ran.
  const kill = (exec: number) =>
    runHost(shell.kill(exec), AbortSignal.timeout(KILL_TIMEOUT_MS)).then(
      () => {},
      () => {},
    )
  // Killed on the abort, not once the host program has exited: an SSH connection's master holds
  // the command's output open until the command in the machine ends. Killed again after it has
  // exited, for a command that started in the machine after the first kill looked.
  const execute = async (exec: number, c: HostCommand, signal?: AbortSignal) => {
    let killed: Promise<void> | undefined
    const onAbort = () => {
      killed = kill(exec)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return text(await runHost(c, signal))
    } catch (error) {
      if (signal?.aborted) {
        await killed
        await kill(exec)
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Starts a host program with its output streamed; its kill ends command `exec` in the machine too. */
  const streamed = (exec: number, c: HostCommand) => {
    const [bin = '', ...args] = c.argv
    const startedAt = Date.now()
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...unsetOtel() },
    })
    child.stdin.on('error', () => {})
    child.stdin.end(c.input)
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      child.once('error', () => resolve({ exitCode: 127 }))
      child.once('close', (code) => {
        traceDocker(args, startedAt, { exitCode: code, stdout: '<streamed>' }, bin)
        resolve({ exitCode: code ?? 1 })
      })
    })
    return {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      wait: () => exited,
      kill: async () => {
        child.kill('SIGKILL')
        await kill(exec)
      },
    }
  }

  const readBinaryFile = async (r: { path: string; abortSignal?: AbortSignal }) => {
    const read = await shell
      .run(shell.direct(['/bin/cat', '--', at(r.path)]), { signal: r.abortSignal })
      .catch(() => null)
    return read?.exitCode === 0 ? new Uint8Array(read.stdout) : null
  }
  const writeBinaryFile = async (w: {
    path: string
    content: Uint8Array
    abortSignal?: AbortSignal
  }) => {
    const target = at(w.path)
    const r = await shell.run(
      shell.direct([
        '/bin/sh',
        '-c',
        'umask 022 && mkdir -p "$(dirname "$1")" && cat > "$1"',
        'sh',
        target,
      ]),
      { input: w.content, signal: w.abortSignal },
    )
    if (r.exitCode !== 0) {
      throw new Error(`Couldn't write ${target} in ${o.name ?? description}: ${r.stderr.trim()}`)
    }
  }
  const paths = pathOperations(
    async (script, path, abortSignal) =>
      text(
        await shell.run(shell.direct(['/bin/sh', '-c', script, 'sh', path]), {
          signal: abortSignal,
        }),
      ),
    o.defaultWorkingDirectory,
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

  const run: HarnessV1NetworkSandboxSession['run'] = (r) => {
    const exec = ++execs
    return execute(
      exec,
      shell.user({ command: r.command, cwd: at(r.workingDirectory), env: o.env(r.env), exec }),
      r.abortSignal,
    )
  }

  const session: DockerSession = {
    id: o.id,
    description,
    defaultWorkingDirectory: o.defaultWorkingDirectory,
    ports: [BRIDGE_PORT],
    get egress(): EgressStatus | undefined {
      if (o.egress?.active && gateway?.stopped) return { active: false, reason: gateway.stopped }
      return o.egress
    },
    ...brokering,
    // A machine without a container's cgroup has nowhere to count the kernel's OOM kills.
    oomKills: async () => null,
    run,
    runPrivileged: (r) => {
      const exec = ++execs
      return execute(exec, shell.privileged({ command: r.command, exec }), r.abortSignal)
    },
    spawn: (async (s: Parameters<DockerSession['spawn']>[0]) => {
      if (s.stdin) throw new Error(`A process in ${description} has no writable stdin`)
      const exec = ++execs
      const p = streamed(
        exec,
        shell.user({ command: s.command, cwd: at(s.workingDirectory), env: o.env(s.env), exec }),
      )
      s.abortSignal?.addEventListener('abort', () => void p.kill(), { once: true })
      return p
    }) as unknown as DockerSession['spawn'],
    spawnPrivileged: async (s) => {
      const exec = ++execs
      return streamed(exec, shell.privileged({ command: s.command, exec }))
    },
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
      const content = Buffer.from(bytes).toString('utf8')
      if (r.startLine === undefined && r.endLine === undefined) return content
      return content
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
      return { url: await o.portWithoutGateway(port, scheme) }
    },
    async getPortUrl(p) {
      return (await session.getPortEndpoint(p)).url
    },
    stop: o.destroy,
    destroy: o.destroy,
    restricted: () => {
      const { readFile, readTextFile, writeFile, writeTextFile, stat, listDirectory } = session
      const { deleteFile, spawn: spawnIn, run: runIn } = session
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
        spawn: spawnIn,
        run: runIn,
      }
    },
  }
  return session
}
