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

export type ImageInfo = {
  labels: Record<string, string>
  /** Content-addressed image id (`sha256:…`): identical bytes on any machine that has it. */
  id: string
  /** Registry digests (`repo@sha256:…`), empty for images that were only built locally. */
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
  return { labels: info.config?.Labels ?? {}, id: info.id, repoDigests: info.repoDigests ?? [] }
}
