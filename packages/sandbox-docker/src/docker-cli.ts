import { spawn } from 'node:child_process'
import { sshArgv } from './egress/transport.ts'
import { type Engine, engineEnv, engineSpec, isRemoteEngine, normalizeImageId } from './engine.ts'
import { shellQuote as q, type RunResult, run, unsetOtel } from './process.ts'
import {
  engineLabel,
  hostCommand,
  isSshFailure,
  remoteBuild,
  retriesSafely,
} from './remote-engine.ts'
import { traceDocker } from './trace.ts'

export type DockerResult = RunResult<Buffer>

export type DockerOptions = {
  input?: Uint8Array | string
  env?: Record<string, string>
  signal?: AbortSignal
  /** The CLI to run; Docker's unless set. */
  engine?: Engine
}

/** How long to wait before each retry of a command that never reached Podman. */
export const CONNECTION_RETRY_MS = [100, 250, 500, 1000, 2000]

/**
 * Whether a podman command failed before reaching the engine: the remote client's SSH handshake
 * or socket connection to `podman machine`, so running it again is safe.
 */
export const isConnectionFailure = (r: { exitCode: number | null; stderr: string }) =>
  r.exitCode === 125 && /ssh: handshake failed|unable to connect to Podman socket/.test(r.stderr)

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

/**
 * Runs `attempt` again, after each of `delays`, while its result is a connection failure (see
 * {@link isConnectionFailure}), and returns the last result.
 */
export async function retryConnection<R extends { exitCode: number | null; stderr: string }>(
  attempt: () => Promise<R>,
  options: {
    delays?: number[]
    signal?: AbortSignal
    wait?: typeof sleep
    failed?: (r: R) => boolean
  } = {},
): Promise<R> {
  const {
    delays = CONNECTION_RETRY_MS,
    signal,
    wait = sleep,
    failed = isConnectionFailure,
  } = options
  let r = await attempt()
  for (const ms of delays) {
    if (!failed(r) || signal?.aborted) break
    await wait(ms, signal)
    r = await attempt()
  }
  return r
}

/**
 * Runs the docker (or podman) CLI, here or on a remote engine's machine. `env` values are passed
 * via the CLI's environment, never argv.
 */
export async function docker(args: string[], options: DockerOptions = {}): Promise<DockerResult> {
  const { engine, signal } = options
  const remote = isRemoteEngine(engine)
  const call = remote ? remoteBuild(args, options.input) : { args, input: options.input }
  const command = hostCommand(engine, call.args, options.env)
  const input = command.preamble
    ? Buffer.concat([command.preamble, Buffer.from(call.input ?? '')])
    : call.input
  const bin = engineLabel(engine)
  const stdin = call.input?.length ?? 0
  const once = async () => {
    const startedAt = Date.now()
    try {
      const r = await run(command.bin, command.args, {
        env: command.env,
        binary: true,
        ...(input !== undefined ? { input } : {}),
        ...(signal ? { signal } : {}),
      })
      traceDocker(call.args, startedAt, { ...r, stdin }, bin)
      return r
    } catch (error) {
      traceDocker(call.args, startedAt, { error }, bin)
      throw error
    }
  }
  if (remote) {
    if (!retriesSafely(call.args)) return once()
    const { target } = engine
    return retryConnection(once, { signal, failed: (r) => isSshFailure(r, target) })
  }
  return engine === 'podman' ? retryConnection(once, { signal }) : once()
}

export async function dockerOk(args: string[], opts?: DockerOptions) {
  const r = await docker(args, opts)
  if (r.exitCode !== 0) {
    throw new Error(`${engineSpec(opts?.engine).bin} ${args[0]} failed: ${r.stderr.trim()}`)
  }
  return r.stdout.toString('utf8').trim()
}

/** Whether `rm -f` left the container gone: it removed it, or it was already gone. */
export const removalDone = (r: { exitCode: number | null; stderr: string }) =>
  r.exitCode === 0 || /no such container/i.test(r.stderr)

/** How long to wait before each retry of a removal that failed. */
export const REMOVAL_RETRY_MS = [250, 500, 1000, 2000, 4000]

/**
 * Removes a container in its own process group, so removal survives this process being killed,
 * and tries again while it fails. Resolves either way.
 */
export async function removeContainerDetached(
  id: string,
  engine?: Engine,
  options: { delays?: number[]; wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const { rmForce } = engineSpec(engine)
  const { delays = REMOVAL_RETRY_MS, wait = sleep } = options
  const args = [...rmForce, id]
  const command = hostCommand(engine, args)
  const bin = command.bin
  const env = { ...process.env, ...command.env }
  const once = () =>
    new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
      // A detached child doesn't keep the event loop alive on its own.
      const keepAlive = setInterval(() => {}, 1000)
      const startedAt = Date.now()
      let stderr = ''
      let settled = false
      const done = (exitCode: number | null) => {
        if (settled) return
        settled = true
        clearInterval(keepAlive)
        traceDocker(args, startedAt, { exitCode, stderr }, engineLabel(engine))
        resolve({ exitCode, stderr })
      }
      const child = spawn(bin, command.args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env,
      })
      child.stderr.on('data', (d) => {
        stderr += d
      })
      child.on('error', (error) => {
        stderr += String(error)
        done(null)
      })
      child.on('close', done)
    })
  let r = await once()
  for (const ms of delays) {
    // No exit code: the CLI didn't start, and won't on a retry.
    if (removalDone(r) || r.exitCode === null) return
    await wait(ms)
    r = await once()
  }
}

/**
 * Removes every container with `label` (`key=value`) for the next few seconds, in its own process
 * group so it outlives this process. For a `docker run` killed mid-way: the daemon may create the
 * container after the CLI dies, and its id never came back.
 */
export function sweepLabelDetached(label: string, seconds = 15, engine?: Engine): void {
  const { bin, rmForce } = engineSpec(engine)
  if (isRemoteEngine(engine)) {
    const filter = q(`label=${label}`)
    const loop = `for i in $(seq ${Math.max(1, Math.floor(seconds))}); do ids=$(docker ps -aq --filter ${filter}); [ -z "$ids" ] || docker ${rmForce.join(' ')} $ids >/dev/null 2>&1; sleep 1; done`
    const [ssh = 'ssh', ...rest] = sshArgv(engine.target, `sh -c ${q(loop)}`)
    const child = spawn(ssh, rest, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return
  }
  // A Node script rather than a shell loop, so it runs where there's no sh (Windows).
  const script = `const { execFileSync } = require('node:child_process')
const [filter, seconds, bin, ...rm] = process.argv.slice(1)
const o = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
for (let i = 0; i < Number(seconds); i++) {
  try {
    const ids = execFileSync(bin, ['ps', '-aq', '--filter', filter], o).split(/\\s+/).filter(Boolean)
    if (ids.length) execFileSync(bin, [...rm, ...ids], o)
  } catch {}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}`
  const child = spawn(
    process.execPath,
    ['-e', script, `label=${label}`, String(seconds), bin, ...rmForce],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // A compiled reeval (bun build --compile) runs as plain Bun, which takes -e, only when told.
      env: { ...process.env, ...unsetOtel(), ...engineEnv(engine), BUN_BE_BUN: '1' },
    },
  )
  child.on('error', () => {})
  child.unref()
}

/**
 * Whether the daemon (or Podman) answers, and runs Linux containers. Docker Desktop on Windows can be switched
 * to Windows containers (GitHub's Windows runners only have those), where no sandbox image runs.
 * `missing` is no CLI on the PATH at all. Aborting `signal` kills `docker info` and rejects with its reason.
 */
export type DockerState = 'running' | 'down' | 'windows-containers' | 'missing'

export async function dockerState(engine?: Engine, signal?: AbortSignal): Promise<DockerState> {
  let missing = false
  const format = engineSpec(engine).stateFormat
  const r = await docker(['info', '--format', format], { engine, signal }).catch(
    (error: NodeJS.ErrnoException) => {
      if (signal?.aborted) throw signal.reason
      missing = error?.code === 'ENOENT'
      return null
    },
  )
  if (missing) return 'missing'
  const [version, os] = r?.exitCode === 0 ? r.stdout.toString('utf8').trim().split(/\s+/) : []
  // Some CLI versions exit 0 without a daemon, printing no server version.
  if (!version) return 'down'
  return os === 'windows' ? 'windows-containers' : 'running'
}

/** Whether Docker (or Podman) is running Linux containers, as every sandbox needs. */
export async function dockerAvailable(engine?: Engine): Promise<boolean> {
  return (await dockerState(engine)) === 'running'
}

/** CPUs and memory of the machine containers run on (the VM, under Docker Desktop or `podman machine`). */
export async function dockerCapacity(
  engine?: Engine,
): Promise<{ cpus: number; memoryBytes: number } | null> {
  const r = await docker(['info', '--format', engineSpec(engine).capacityFormat], {
    engine,
  }).catch(() => null)
  if (r?.exitCode !== 0) return null
  const [cpus, memoryBytes] = r.stdout.toString('utf8').trim().split(/\s+/).map(Number)
  return cpus && memoryBytes ? { cpus, memoryBytes } : null
}

/**
 * Whether a RepoDigest shows the image is in a registry someone can pull from. The containerd
 * image store (Docker 29+, recent Docker Desktop) also gives locally built images a digest, under
 * their bare local name (`reeval-sandbox@sha256:…`). A bare name is Docker Hub's `library/`
 * namespace, which only official images can push to, so only a digest whose name has a registry
 * host or a namespace counts. Official images such as `busybox` count as local; no image with
 * the harness baked in is one. Podman names local images `localhost/…`, which no one pulls from.
 */
export const isRegistryDigest = (digest: string) => {
  const name = digest.split('@')[0] ?? ''
  return name.includes('/') && !name.startsWith('localhost/')
}

export type ImageInfo = {
  labels: Record<string, string>
  /** Content-addressed image id (`sha256:…`): identical bytes on any machine that has it. */
  id: string
  /** Registry digests (`repo@sha256:…`), empty for images that were only built locally (see {@link isRegistryDigest}). */
  repoDigests: string[]
  /** `os/architecture`, as `PLATFORM` names one; null when the engine doesn't say. */
  platform: string | null
}

/** `repository:tag` of every local image in `repository`; none when the CLI fails. */
export async function imageTags(repository: string, engine?: Engine): Promise<string[]> {
  const r = await docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repository], {
    engine,
  }).catch(() => null)
  if (r?.exitCode !== 0) return []
  // Podman names local images `localhost/…`.
  return r.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((t) => t.replace(/^localhost\//, ''))
}

/** `image inspect`'s answer when the engine has no such image (Docker's wording, then Podman's). */
export const isNoSuchImage = (stderr: string) => /no such image|image not known/i.test(stderr)

/**
 * The image, or null when the engine says it has no such image. A CLI that can't start or a daemon
 * that doesn't answer throws instead, naming the error: that's not knowing, not a missing image.
 */
export async function imageInfo(image: string, engine?: Engine): Promise<ImageInfo | null> {
  const { bin, imageId } = engineSpec(engine)
  const r = await docker(
    [
      'image',
      'inspect',
      '--format',
      // `.Config.Labels` is a template error, not null, on images without labels.
      `{"config":{{json .Config}},"id":{{json ${imageId}}},"repoDigests":{{json .RepoDigests}},"os":{{json .Os}},"arch":{{json .Architecture}}}`,
      image,
    ],
    { engine },
  ).catch((error: Error) => {
    throw new Error(`${bin} image inspect ${image} couldn't run: ${error.message}`)
  })
  if (r.exitCode !== 0) {
    const stderr = r.stderr.trim()
    if (isNoSuchImage(stderr)) return null
    throw new Error(`${bin} image inspect ${image} failed: ${stderr || `exit ${r.exitCode}`}`)
  }
  const info = JSON.parse(r.stdout.toString('utf8'))
  const repoDigests = ((info.repoDigests ?? []) as string[]).filter(isRegistryDigest)
  const platform = info.os && info.arch ? `${info.os}/${info.arch}` : null
  return { labels: info.config?.Labels ?? {}, id: normalizeImageId(info.id), repoDigests, platform }
}
