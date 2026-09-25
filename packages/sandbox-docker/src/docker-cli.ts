import { spawn } from 'node:child_process'
import { type RunResult, run } from './process.ts'

export type DockerResult = RunResult<Buffer>

/** Runs the docker CLI. `env` values are passed via the CLI's environment, never argv. */
export const docker = (
  args: string[],
  options: { input?: Uint8Array | string; env?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<DockerResult> => run('docker', args, { ...options, binary: true })

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
    const done = () => {
      clearInterval(keepAlive)
      resolve()
    }
    const child = spawn('docker', ['rm', '-f', id], { detached: true, stdio: 'ignore' })
    child.on('error', done)
    child.on('close', done)
  })
}

/**
 * Removes every container with `label` (`key=value`) for the next few seconds, in its own process
 * group so it outlives this process. For a `docker run` killed mid-way: the daemon may create the
 * container after the CLI dies, and its id never came back.
 */
export function sweepLabelDetached(label: string, seconds = 15): void {
  const filter = `label=${label}`.replaceAll("'", '')
  const script = `for i in $(seq ${seconds}); do ids=$(docker ps -aq --filter '${filter}'); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1; sleep 1; done`
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    return (await docker(['info', '--format', '{{.ServerVersion}}'])).exitCode === 0
  } catch {
    return false
  }
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
  ])
  if (r.exitCode !== 0) return null
  const info = JSON.parse(r.stdout.toString('utf8'))
  const repoDigests = ((info.repoDigests ?? []) as string[]).filter(isRegistryDigest)
  return { labels: info.config?.Labels ?? {}, id: info.id, repoDigests }
}
