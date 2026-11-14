// A sandbox's harness session as the Runner @reeval/agents drives a harness on, with the network
// half (policy and brokering) passed through to the adapter untouched.
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { Proc, Runner, RunnerInfo, RunnerSessionOptions } from '@reeval/agents'
import { shellQuote } from '@reeval/sandbox-docker/process'
import type { NetworkSandbox } from '../sandbox/types.ts'

type Session = HarnessV1NetworkSandboxSession
type Spawned = Awaited<ReturnType<ReturnType<Session['restricted']>['spawn']>>

const PLATFORMS: Record<string, 'linux' | 'darwin'> = { Linux: 'linux', Darwin: 'darwin' }
const ARCHES: Record<string, 'x64' | 'arm64'> = {
  x86_64: 'x64',
  amd64: 'x64',
  aarch64: 'arm64',
  arm64: 'arm64',
}

/** A stream of `from`'s once it has started; it errors when starting fails. */
function later(from: Promise<ReadableStream<Uint8Array>>): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  return new ReadableStream({
    async pull(controller) {
      reader ??= (await from).getReader()
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    async cancel(reason) {
      reader ??= await from.then((s) => s.getReader()).catch(() => undefined)
      await reader?.cancel(reason)
    },
  })
}

/** A session's process as a {@link Proc}, which is returned before the process has started. */
function procOf(started: Promise<Spawned & { stdin?: WritableStream<Uint8Array> }>): Proc {
  started.catch(() => {})
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  const stdin = async () => {
    const { stdin } = await started
    if (!stdin) throw new Error("the process wasn't spawned with stdin: 'pipe'")
    writer ??= stdin.getWriter()
    return writer
  }
  return {
    stdout: later(started.then((p) => p.stdout)),
    stderr: later(started.then((p) => p.stderr)),
    write: async (chunk) =>
      (await stdin()).write(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk),
    end: async () => (await stdin()).close(),
    kill: async () => {
      const proc = await started.catch(() => undefined)
      await proc?.kill()
    },
    exited: started.then(async (p) => ({ code: (await p.wait()).exitCode, signal: null })),
  }
}

/** What the session's machine is, from `uname`, for {@link RunnerInfo}. */
async function probe(network: Session, home: string): Promise<RunnerInfo> {
  const { exitCode, stdout, stderr } = await network.run({ command: 'uname -s; uname -m' })
  const [system = '', machine = ''] = stdout.trim().split('\n')
  const platform = PLATFORMS[system.trim()]
  const arch = ARCHES[machine.trim()]
  if (exitCode !== 0 || !platform || !arch) {
    throw new Error(
      `can't tell the sandbox's platform from uname: ${stdout.trim() || stderr.trim()}`,
    )
  }
  return {
    platform: `${platform}-${arch}`,
    home,
    cwd: network.defaultWorkingDirectory,
    shell: '/bin/sh',
  }
}

/**
 * `sandbox`'s harness session as a {@link Runner}, with what the session the driver builds over
 * it says of itself: the sandbox session's id, description and ports. The sandbox owns the
 * machine, so closing the runner leaves it running.
 */
export function runnerOf(sandbox: NetworkSandbox): {
  runner: Runner
  session: RunnerSessionOptions
} {
  const { network } = sandbox
  let info: Promise<RunnerInfo> | undefined
  const runner: Runner = {
    info: () => {
      info ??= probe(network, sandbox.home)
      return info
    },
    spawn(cmd, o = {}) {
      const command = typeof cmd === 'string' ? cmd : cmd.map(shellQuote).join(' ')
      const spawn = network.spawn as (o: {
        command: string
        workingDirectory?: string
        env?: Record<string, string>
        abortSignal?: AbortSignal
        stdin?: boolean
      }) => Promise<Spawned & { stdin?: WritableStream<Uint8Array> }>
      return procOf(
        Promise.resolve().then(() =>
          spawn({
            command,
            ...(o.cwd && { workingDirectory: o.cwd }),
            ...(o.env && { env: o.env }),
            ...(o.signal && { abortSignal: o.signal }),
            ...(o.stdin === 'pipe' && { stdin: true }),
          }),
        ),
      )
    },
    readFile: (path) => Promise.resolve(network.readBinaryFile({ path })),
    async writeFile(path, data, o) {
      const content = typeof data === 'string' ? new TextEncoder().encode(data) : data
      await network.writeBinaryFile({ path, content })
      if (o?.mode === undefined) return
      const chmod = await network.run({
        command: `chmod ${o.mode.toString(8)} ${shellQuote(path)}`,
      })
      if (chmod.exitCode !== 0) throw new Error(`chmod ${path}: ${chmod.stderr.trim()}`)
    },
    async forwardPort(port) {
      const { url } = await network.getPortEndpoint({ port, protocol: 'http' })
      const { hostname, port: hostPort } = new URL(url)
      return { host: hostname, port: Number(hostPort), close: async () => {} }
    },
    close: async () => {},
    network: {
      ...(network.setNetworkPolicy && {
        setNetworkPolicy: network.setNetworkPolicy.bind(network),
      }),
      ...(network.addRequestTransformations && {
        addRequestTransformations: network.addRequestTransformations.bind(network),
      }),
      ...(network.setRequestTransformations && {
        setRequestTransformations: network.setRequestTransformations.bind(network),
      }),
    },
  }
  return {
    runner,
    session: { id: network.id, description: network.description, ports: [...network.ports] },
  }
}
