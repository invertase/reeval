import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  allocatePort,
  cacheLabel,
  checkCaptureName,
  ensureChrome,
  pageUrl,
  pollHttp,
  refusedBrowser,
  resolveCaptureCall,
  screenshotWithChrome,
  stubPng,
} from '../capture/index.ts'
import { sha256 } from '../ids.ts'
import { cacheDir } from '../root.ts'
import type { BackgroundHandle, Capture, CaptureCall, ServeHandle } from '../types.ts'
import { asCheck, requireSandbox } from './checks.ts'
import type { Attempt } from './state.ts'

const BG_LOG = '/tmp/reeval-bg.log'

export type CaptureArtifact = {
  name: string
  mediaType: 'image/png'
  sha256: string
  bytes: number
  capture: { port: number; path: string; viewport: { width: number; height: number } }
}

/** Starts `command` without waiting for exit. Teardown kills it if the eval didn't. */
export async function startBackground(
  a: Attempt,
  command: string,
  extraEnv: Record<string, string> = {},
): Promise<BackgroundHandle> {
  const box = requireSandbox(a)
  const wrapped = `${command} >${BG_LOG} 2>&1 & echo $!`
  const r = await asCheck(a, () =>
    box.exec(wrapped, {
      signal: a.signal,
      env: { ...(a.env?.checkVars ?? {}), ...extraEnv },
    }),
  )
  const pid = r.stdout.trim().split(/\s+/).at(-1) ?? ''
  if (!/^\d+$/.test(pid)) {
    throw new Error(
      `c.exec({ background: true }) did not start (no pid):\n${(r.stderr || r.stdout).trim()}`,
    )
  }
  let killed = false
  const handle: BackgroundHandle = {
    async kill() {
      if (killed) return
      killed = true
      await box.exec(`kill ${pid} 2>/dev/null || true`, { signal: a.signal }).catch(() => {})
    },
  }
  a.backgrounds.push(handle)
  return handle
}

export async function serveCommand(
  a: Attempt,
  command: string,
  port?: number,
): Promise<ServeHandle> {
  const bound = port ?? (await allocatePort())
  const handle = await startBackground(a, command, { PORT: String(bound) })
  return { ...handle, port: bound }
}

export async function capturePage(a: Attempt, call: CaptureCall): Promise<Capture> {
  const refused = refusedBrowser(a.spec.capture)
  if (refused) throw new Error(refused)
  checkCaptureName(call.name)
  if (a.captureNames.has(call.name)) {
    throw new Error(`c.capture() reused the name "${call.name}"`)
  }
  const resolved = resolveCaptureCall(call, a.spec.capture)
  const box = requireSandbox(a, 'c.capture()')
  if (!box.getPortEndpoint) {
    throw new Error('c.capture() needs a sandbox that can tunnel a port')
  }
  const { url: origin } = await box.getPortEndpoint({
    port: resolved.port,
    protocol: 'http',
  })
  try {
    await pollHttp(pageUrl(origin, '/'), resolved.timeoutMs, a.signal)
  } catch {
    throw new Error(`nothing listening on port ${resolved.port}`)
  }
  a.captureNames.add(call.name)
  const png =
    a.spec.sandbox.kind === 'fake'
      ? stubPng(call.name, resolved.port, resolved.path, resolved.viewport)
      : await shot(a, pageUrl(origin, resolved.path), resolved.viewport, resolved.timeoutMs)
  const digest = sha256(png)
  const file = {
    path: `artifacts/${call.name}.png`,
    sha256: digest,
    bytes: png.length,
  }
  a.record.artifacts = a.record.artifacts ?? []
  a.record.artifacts.push({
    name: call.name,
    mediaType: 'image/png',
    sha256: digest,
    bytes: png.length,
    capture: { port: resolved.port, path: resolved.path, viewport: resolved.viewport },
  })
  a.artifactBlobs.set(call.name, png)
  return {
    name: call.name,
    port: resolved.port,
    path: resolved.path,
    viewport: resolved.viewport,
    file,
  }
}

async function shot(
  a: Attempt,
  url: string,
  viewport: { width: number; height: number },
  timeoutMs: number,
): Promise<Buffer> {
  const cache = cacheDir()
  const bin = await ensureChrome(cache, {
    cacheLabel: cacheLabel(cache),
    signal: a.signal,
    onProgress: (p) => a.report({ kind: 'browser-download', ...p }),
  })
  return screenshotWithChrome(bin, url, viewport, timeoutMs)
}

/** Writes PNG sidecars next to the staging eval JSON so redact never sees the bytes. */
export async function writeCaptureSidecars(
  stagingDir: string,
  recordFile: string,
  blobs: Map<string, Buffer>,
): Promise<void> {
  if (blobs.size === 0) return
  const dir = join(stagingDir, 'evals', recordFile.replace(/\.json$/, '.artifacts'))
  await mkdir(dir, { recursive: true })
  for (const [name, png] of blobs) await writeFile(join(dir, `${name}.png`), png)
}
