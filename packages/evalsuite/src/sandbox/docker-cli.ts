import { spawn } from 'node:child_process'

export type DockerResult = { exitCode: number; stdout: Buffer; stderr: string }

/** Runs the docker CLI. `env` values are passed via the CLI's environment, never argv. */
export function docker(
  args: string[],
  opts: { input?: Buffer | string; env?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(opts.signal.reason)
    // Own process group: Ctrl-C goes to ES, which then aborts and kills this child itself.
    const child = spawn('docker', args, {
      stdio: 'pipe',
      detached: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d) => {
      stderr += d
    })
    const onAbort = () => child.kill('SIGKILL')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(opts.signal.reason)
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr })
    })
    // The child may exit before reading its stdin.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
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

export async function imageLabels(image: string): Promise<Record<string, string> | null> {
  const r = await docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', image])
  if (r.exitCode !== 0) return null
  return JSON.parse(r.stdout.toString('utf8')) ?? {}
}
