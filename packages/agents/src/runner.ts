import { spawn as spawnHost } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'

/** Where a runner runs commands: what a harness's setup picks its build by, and its paths. */
export type RunnerInfo = {
  platform: `${'linux' | 'darwin'}-${'x64' | 'arm64'}`
  /** On Linux, the C library its binaries need. */
  libc?: 'glibc' | 'musl'
  /** Absolute. */
  home: string
  /** The directory commands start in, and relative paths resolve against. Absolute. */
  cwd: string
  user?: string
  /** What runs a string command: `<shell> -c <command>`. */
  shell: string
}

export type SpawnOptions = {
  /** Absolute, or relative to {@link RunnerInfo.cwd}. */
  cwd?: string
  /** Merged over the runner's own environment. */
  env?: Record<string, string>
  /** `ignore` (the default) closes stdin at once; `pipe` keeps it open for `write` and `end`. */
  stdin?: 'pipe' | 'ignore'
  /** Aborting it kills the process tree, as {@link Proc.kill} does. */
  signal?: AbortSignal
}

export type ProcExit = { code: number | null; signal: string | null }

/** A process a runner started. */
export type Proc = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  /** Writes to stdin; rejects unless it was spawned with `stdin: 'pipe'`. */
  write(chunk: string | Uint8Array): Promise<void>
  /** Closes stdin, delivering EOF. */
  end(): Promise<void>
  /** Signals the whole process tree, `SIGTERM` by default. Idempotent. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>
  exited: Promise<ProcExit>
}

/** Where an agent's CLI runs: this machine, a container, a VM. The core never asks which. */
export interface Runner {
  info(): Promise<RunnerInfo>
  /** An argv runs as is; a string runs through {@link RunnerInfo.shell}. */
  spawn(cmd: string | string[], options?: SpawnOptions): Proc
  /** `null` when the file doesn't exist. A relative path is under {@link RunnerInfo.cwd}. */
  readFile(path: string): Promise<Uint8Array | null>
  /** Creates the parent directories and replaces the file. */
  writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>
  /** Copies a host directory's contents into `boxDir`; {@link withFallbacks} gives tar over `spawn`. */
  upload?(hostDir: string, boxDir: string): Promise<void>
  /** Copies `boxDir`'s contents into a host directory; {@link withFallbacks} gives tar over `spawn`. */
  download?(boxDir: string, hostDir: string): Promise<void>
  /** Where the host reaches a port the runner listens on. */
  forwardPort?(port: number): Promise<{ host: string; port: number; close(): Promise<void> }>
  /** Kills every process it started and releases what it holds. Idempotent. */
  close(): Promise<void>
  /**
   * Handed to the AI SDK adapter as is, and never called by the core: a runner that enforces a
   * network policy or adds credentials outside the box sets these. Without them an adapter
   * passes the harness's key in the CLI's environment.
   */
  network?: Pick<
    HarnessV1NetworkSandboxSession,
    'setNetworkPolicy' | 'addRequestTransformations' | 'setRequestTransformations'
  >
}

/** Runs `tar` on the host, with its stdin and stdout piped. */
function hostTar(args: string[]) {
  const child = spawnHost('tar', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d
  })
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar ${args[0]} on the host: ${stderr.trim()}`)),
    )
  })
  return { child, done }
}

/** Reads a stream to text, for an error message. */
async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = ''
  const decoder = new TextDecoder()
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true })
  return out + decoder.decode()
}

async function succeeded(proc: Proc, what: string) {
  const [exit, stderr] = await Promise.all([proc.exited, text(proc.stderr)])
  if (exit.code !== 0) {
    throw new Error(`${what}: ${stderr.trim() || `exit ${exit.code ?? exit.signal}`}`)
  }
}

/**
 * Pumps one tar into the other and waits for both ends. On a failure it stops both and throws
 * the first end's own error, in `ends` order, rather than the broken pipe that followed it.
 */
async function tarPipe(
  pump: () => Promise<void>,
  ends: Promise<void>[],
  stop: () => Promise<void>,
): Promise<void> {
  for (const end of ends) end.catch(() => {})
  try {
    await pump()
    await Promise.all(ends)
  } catch (error) {
    await stop()
    const failed = (await Promise.allSettled(ends)).find((r) => r.status === 'rejected')
    throw failed ? failed.reason : error
  }
}

/** Copies a host directory into the runner with `tar` on both ends, over `spawn`'s stdin. */
async function tarUpload(runner: Runner, hostDir: string, boxDir: string) {
  const proc = runner.spawn(['sh', '-c', 'mkdir -p "$1" && tar -x -C "$1"', 'sh', boxDir], {
    stdin: 'pipe',
  })
  const untar = succeeded(proc, `untar into ${boxDir}`)
  const drained = proc.stdout.cancel()
  const tar = hostTar(['-c', '-C', hostDir, '.'])
  await tarPipe(
    async () => {
      for await (const chunk of tar.child.stdout) await proc.write(chunk as Uint8Array)
      await proc.end()
    },
    [untar, tar.done, drained],
    async () => {
      tar.child.kill()
      await proc.kill('SIGKILL')
    },
  )
}

/** Copies a runner directory to the host with `tar` on both ends, over `spawn`'s stdout. */
async function tarDownload(runner: Runner, boxDir: string, hostDir: string) {
  await mkdir(hostDir, { recursive: true })
  const proc = runner.spawn(['tar', '-c', '-C', boxDir, '.'])
  const archive = succeeded(proc, `tar ${boxDir}`)
  const tar = hostTar(['-x', '-C', hostDir])
  tar.child.stdout.resume()
  const { stdin } = tar.child
  await tarPipe(
    async () => {
      for await (const chunk of proc.stdout) {
        if (!stdin.write(chunk)) {
          await Promise.race([new Promise((resolve) => stdin.once('drain', resolve)), tar.done])
        }
      }
      stdin.end()
    },
    [archive, tar.done],
    async () => {
      tar.child.kill()
      await proc.kill('SIGKILL')
    },
  )
}

/**
 * The runner, with `upload` and `download` as tar streamed over `spawn` where it has none of
 * its own. Needs `tar` on the host and in the runner.
 */
export function withFallbacks(
  runner: Runner,
): Runner & Required<Pick<Runner, 'upload' | 'download'>> {
  const { upload, download, forwardPort } = runner
  return {
    info: () => runner.info(),
    spawn: (cmd, options) => runner.spawn(cmd, options),
    readFile: (path) => runner.readFile(path),
    writeFile: (path, data, options) => runner.writeFile(path, data, options),
    upload: upload
      ? (hostDir, boxDir) => upload.call(runner, hostDir, boxDir)
      : (hostDir, boxDir) => tarUpload(runner, hostDir, boxDir),
    download: download
      ? (boxDir, hostDir) => download.call(runner, boxDir, hostDir)
      : (boxDir, hostDir) => tarDownload(runner, boxDir, hostDir),
    ...(forwardPort && { forwardPort: (port: number) => forwardPort.call(runner, port) }),
    close: () => runner.close(),
    ...(runner.network && { network: runner.network }),
  }
}
