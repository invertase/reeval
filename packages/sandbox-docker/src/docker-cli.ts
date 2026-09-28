import { spawn } from 'node:child_process'
import { type RunResult, run } from './process.ts'
import { traceDocker } from './trace.ts'

export type DockerResult = RunResult<Buffer>

/** Runs the docker CLI. `env` values are passed via the CLI's environment, never argv. */
export async function docker(
  args: string[],
  options: { input?: Uint8Array | string; env?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<DockerResult> {
  const startedAt = Date.now()
  const stdin = options.input?.length ?? 0
  try {
    const r = await run('docker', args, { ...options, binary: true })
    traceDocker(args, startedAt, { ...r, stdin })
    return r
  } catch (error) {
    traceDocker(args, startedAt, { error })
    throw error
  }
}

export async function dockerOk(args: string[], opts?: Parameters<typeof docker>[1]) {
  const r = await docker(args, opts)
  if (r.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.trim()}`)
  return r.stdout.toString('utf8').trim()
}

/** Removes a container in its own process group, so removal survives this process being killed. */
export function removeContainerDetached(id: string): Promise<void> {
  return new Promise((resolve) => {
    // A detached child doesn't keep the event loop alive on its own.
    const keepAlive = setInterval(() => {}, 1000)
    const startedAt = Date.now()
    const args = ['rm', '-f', id]
    const done = (exitCode: number | null) => {
      clearInterval(keepAlive)
      traceDocker(args, startedAt, { exitCode })
      resolve()
    }
    const child = spawn('docker', args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => done(null))
    child.on('close', done)
  })
}

/**
 * Removes every container with `label` (`key=value`) for the next few seconds, in its own process
 * group so it outlives this process. For a `docker run` killed mid-way: the daemon may create the
 * container after the CLI dies, and its id never came back.
 */
export function sweepLabelDetached(label: string, seconds = 15): void {
  // A Node script rather than a shell loop, so it runs where there's no sh (Windows).
  const script = `const { execFileSync } = require('node:child_process')
const [filter, seconds] = process.argv.slice(1)
const o = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
for (let i = 0; i < Number(seconds); i++) {
  try {
    const ids = execFileSync('docker', ['ps', '-aq', '--filter', filter], o).split(/\\s+/).filter(Boolean)
    if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], o)
  } catch {}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}`
  const child = spawn(process.execPath, ['-e', script, `label=${label}`, String(seconds)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // A compiled es (bun build --compile) runs as plain Bun, which takes -e, only when told.
    env: { ...process.env, BUN_BE_BUN: '1' },
  })
  child.on('error', () => {})
  child.unref()
}

/**
 * Whether the daemon answers, and runs Linux containers. Docker Desktop on Windows can be switched
 * to Windows containers (GitHub's Windows runners only have those), where no sandbox image runs.
 */
export type DockerState = 'running' | 'down' | 'windows-containers'

export async function dockerState(): Promise<DockerState> {
  const r = await docker(['info', '--format', '{{.ServerVersion}} {{.OSType}}']).catch(() => null)
  const [version, os] = r?.exitCode === 0 ? r.stdout.toString('utf8').trim().split(/\s+/) : []
  // Some CLI versions exit 0 without a daemon, printing no server version.
  if (!version) return 'down'
  return os === 'windows' ? 'windows-containers' : 'running'
}

/** Whether Docker is running Linux containers, as every sandbox needs. */
export async function dockerAvailable(): Promise<boolean> {
  return (await dockerState()) === 'running'
}

/** CPUs and memory of the machine containers run on (the VM, under Docker Desktop). */
export async function dockerCapacity(): Promise<{ cpus: number; memoryBytes: number } | null> {
  const r = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}']).catch(() => null)
  if (r?.exitCode !== 0) return null
  const [cpus, memoryBytes] = r.stdout.toString('utf8').trim().split(/\s+/).map(Number)
  return cpus && memoryBytes ? { cpus, memoryBytes } : null
}

/**
 * Whether a RepoDigest shows the image is in a registry someone can pull from. The containerd
 * image store (Docker 29+, recent Docker Desktop) also gives locally built images a digest, under
 * their bare local name (`evalsuite-sandbox@sha256:…`). A bare name is Docker Hub's `library/`
 * namespace, which only official images can push to, so only a digest whose name has a registry
 * host or a namespace counts. Official images such as `busybox` count as local; no image with
 * the harness baked in is one.
 */
export const isRegistryDigest = (digest: string) => (digest.split('@')[0] ?? '').includes('/')

export type ImageInfo = {
  labels: Record<string, string>
  /** Content-addressed image id (`sha256:…`): identical bytes on any machine that has it. */
  id: string
  /** Registry digests (`repo@sha256:…`), empty for images that were only built locally (see {@link isRegistryDigest}). */
  repoDigests: string[]
}

export async function imageInfo(image: string): Promise<ImageInfo | null> {
  const r = await docker([
    'image',
    'inspect',
    '--format',
    // `.Config.Labels` is a template error, not null, on images without labels.
    '{"config":{{json .Config}},"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}',
    image,
  ]).catch(() => null)
  // No docker CLI at all (spawn ENOENT) is no image, as a daemon that doesn't have it is.
  if (r?.exitCode !== 0) return null
  const info = JSON.parse(r.stdout.toString('utf8'))
  const repoDigests = ((info.repoDigests ?? []) as string[]).filter(isRegistryDigest)
  return { labels: info.config?.Labels ?? {}, id: info.id, repoDigests }
}
