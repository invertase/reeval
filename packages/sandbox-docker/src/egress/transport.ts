import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { docker } from '../docker-cli.ts'
import { type Engine, engineEnv, engineSpec } from '../engine.ts'
import { type RunResult, run } from '../process.ts'
import { traceDocker } from '../trace.ts'

/** How a host command ended, as a debug trace records it. */
export type ExecEnd = Parameters<typeof traceDocker>[2]

/**
 * How the egress gateway runs a process inside a sandbox, with its stdin, stdout and stderr piped
 * to this process: `docker exec -i` for a container, `tart exec -i` or `ssh -T` for a VM.
 *
 * The process runs as root, whoever the sandbox runs as: the sandbox user can't signal, trace or
 * replace the forwarder, or change the CA the gateway installed.
 */
export type ExecTransport = {
  /** The host argv, program first, that runs `command` in the sandbox as root with stdin open. */
  argv(command: readonly string[]): string[]
  /** Variables the host program runs with, over this process's. Never credentials in `argv`. */
  env?: Record<string, string>
  /** Runs `command` to its end with `input` on stdin; running `argv(command)` unless set. */
  run?(
    command: readonly string[],
    options: { input: string; signal?: AbortSignal },
  ): Promise<RunResult<Buffer>>
  /** Called as each host command this transport started ends, for debug traces. */
  trace?(argv: readonly string[], startedAt: number, end: ExecEnd): void
  /**
   * Killing the host program can leave its process running in the sandbox, where the sandbox
   * outlives it (`tart exec`, `ssh`), so the gateway stops its forwarder there itself: any left
   * from an earlier gateway before it starts one, and its own when it closes. A container's
   * forwarder goes with the container.
   */
  orphans?: boolean
}

/** Runs `command` in the sandbox to its end. */
export async function execRun(
  transport: ExecTransport,
  command: readonly string[],
  options: { input: string; signal?: AbortSignal },
): Promise<RunResult<Buffer>> {
  if (transport.run) return transport.run(command, options)
  const [bin = '', ...args] = transport.argv(command)
  const startedAt = Date.now()
  try {
    const r = await run(bin, args, { ...options, env: transport.env, binary: true })
    transport.trace?.([bin, ...args], startedAt, { ...r, stdin: options.input.length })
    return r
  } catch (error) {
    transport.trace?.([bin, ...args], startedAt, { error })
    throw error
  }
}

/** Starts `command` in the sandbox and leaves it running, its stdio piped. */
export function execSpawn(
  transport: ExecTransport,
  command: readonly string[],
): ChildProcessWithoutNullStreams {
  const argv = transport.argv(command)
  const [bin = '', ...args] = argv
  const startedAt = Date.now()
  // Own process group, like every docker call: reeval handles Ctrl-C and tears the gateway down.
  const child = spawn(bin, args, {
    stdio: 'pipe',
    detached: true,
    env: { ...process.env, ...transport.env },
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  child.once('close', (code) => transport.trace?.(argv, startedAt, { exitCode: code, stderr }))
  return child
}

/** `docker exec` (or `podman exec`) into a running container, as root. */
export function containerTransport(containerId: string, engine?: Engine): ExecTransport {
  const { bin } = engineSpec(engine)
  const exec = (command: readonly string[]) => [
    'exec',
    '--interactive',
    '--user',
    '0:0',
    containerId,
    ...command,
  ]
  return {
    argv: (command) => [bin, ...exec(command)],
    env: engineEnv(engine),
    run: (command, { input, signal }) => docker(exec(command), { input, signal, engine }),
    trace: (argv, startedAt, end) => traceDocker(argv.slice(1), startedAt, end, bin),
  }
}
