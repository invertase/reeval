import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { providerModel } from '../analysis/model.ts'
import {
  allocatePort,
  cacheLabel,
  ensureChrome,
  instructionGoals,
  pageUrl,
  pollHttp,
  type ResolvedCaptureCall,
  refusedBrowser,
  resolveCaptureCall,
  withChrome,
} from '../capture/index.ts'
import { stubPng } from '../capture/stub.ts'
import { captureUseSpend, runJourney } from '../capture/use.ts'
import { getRunContext } from '../engine/runtime.ts'
import { sha256 } from '../ids.ts'
import { judgeRoute } from '../judge/index.ts'
import { cacheDir } from '../root.ts'
import type {
  BackgroundHandle,
  Capture,
  CaptureArtifactMeta,
  CaptureCall,
  CaptureUse,
  ServeHandle,
} from '../types.ts'
import { addUsage } from '../usage.ts'
import { asCheck, requireSandbox } from './checks.ts'
import type { Attempt } from './state.ts'

const BG_LOG = '/tmp/reeval-bg.log'

export type CaptureArtifact = {
  name: string
  mediaType: 'image/png'
  sha256: string
  bytes: number
  capture: CaptureArtifactMeta
}

const isEvaluationModel = (model: string) => model.startsWith('typesafe-ai/')

function defaultCaptureModel(): string | undefined {
  try {
    const { config } = getRunContext()
    const analysis = config.analysis.model
    if (typeof analysis === 'string' && !isEvaluationModel(analysis)) return analysis
    const judge = config.judge.model
    if (typeof judge === 'string' && !isEvaluationModel(judge)) return judge
  } catch {
    return undefined
  }
}

function resolveUse(resolved: ResolvedCaptureCall, fakeSandbox: boolean): CaptureUse | undefined {
  if (resolved.fake) return { fake: resolved.fake }
  if (resolved.model) return { model: resolved.model }
  if (!resolved.instructions.length) return undefined
  const fallback = defaultCaptureModel()
  if (fallback) return { model: fallback }
  if (fakeSandbox) return undefined
  throw new Error(
    'c.capture() instructions need a vision model. Set capture.model, pass model on the call, or analysis.model to a language model that accepts images. Tests pass fake on the call.',
  )
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
      // Do not pass a.signal: after a timeout it is already aborted, and run() would skip the kill.
      // SIGTERM does not stop native node.exe started from Git Bash; SIGKILL plus the Win32 pid does.
      const win =
        a.spec.sandbox.kind === 'fake' && process.platform === 'win32'
          ? `; wp=$(tr -d '\\r\\n' < /proc/${pid}/winpid 2>/dev/null) && taskkill /F /PID "$wp" >/dev/null 2>&1 || true`
          : ''
      await box.exec(`kill -9 ${pid} 2>/dev/null || true${win}`).catch(() => {})
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

export async function capturePage(
  a: Attempt,
  target: number | ServeHandle,
  call?: CaptureCall,
): Promise<Capture> {
  const refused = refusedBrowser(a.spec.capture)
  if (refused) throw new Error(refused)
  const resolved = resolveCaptureCall(target, call, a.spec.capture)
  if (a.captureNames.has(resolved.name)) {
    throw new Error(`c.capture() reused the name "${resolved.name}"`)
  }
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
  const fake = a.spec.sandbox.kind === 'fake'
  const use = resolveUse(resolved, fake)
  a.captureNames.add(resolved.name)
  const started = Date.now()
  const remaining = () => Math.max(0, resolved.timeoutMs - (Date.now() - started))
  let moves = 0
  const png = fake
    ? stubPng(resolved.name, resolved.port, resolved.path, resolved.viewport)
    : await shot(a, pageUrl(origin, resolved.path), { ...resolved, use }, remaining, (n) => {
        moves = n
      })
  const digest = sha256(png)
  const file = {
    path: `artifacts/${resolved.name}.png`,
    sha256: digest,
    bytes: png.length,
  }
  const goals = instructionGoals(resolved.instructions)
  const capture: CaptureArtifactMeta = {
    port: resolved.port,
    path: resolved.path,
    viewport: resolved.window,
    ...(resolved.fullPage ? { fullPage: true } : {}),
    ...(goals.length ? { instructions: goals } : {}),
    ...(use ? { use: { model: 'model' in use ? use.model : 'fake', moves } } : {}),
  }
  a.record.artifacts = a.record.artifacts ?? []
  a.record.artifacts.push({
    name: resolved.name,
    mediaType: 'image/png',
    sha256: digest,
    bytes: png.length,
    capture,
  })
  a.artifactBlobs.set(resolved.name, png)
  return {
    name: resolved.name,
    port: resolved.port,
    path: resolved.path,
    viewport: resolved.viewport,
    file,
  }
}

async function shot(
  a: Attempt,
  url: string,
  resolved: ResolvedCaptureCall & { use?: CaptureUse },
  remaining: () => number,
  onMoves: (n: number) => void,
): Promise<Buffer> {
  const cache = cacheDir()
  const bin = await ensureChrome(cache, {
    cacheLabel: cacheLabel(cache),
    signal: a.signal,
    onProgress: (p) => a.report({ kind: 'browser-download', ...p }),
  })
  return withChrome(bin, resolved.window, remaining(), async (session) => {
    const result = await runJourney(session, url, {
      wait: resolved.wait,
      timeoutMs: remaining(),
      fullPage: resolved.fullPage,
      instructions: resolved.instructions,
      use: resolved.use,
      remaining,
      loadModel: async (name) => {
        const route = judgeRoute(name)
        return providerModel({
          name,
          route: route.kind === 'direct' ? 'direct' : 'gateway',
        })
      },
    })
    onMoves(result.moves)
    const spend = captureUseSpend(result)
    if (spend) {
      const prev = a.record.captureUse
      a.record.captureUse = prev
        ? {
            model: spend.model,
            moves: prev.moves + spend.moves,
            usage: addUsage(prev.usage, spend.usage),
          }
        : spend
    }
    return result.png
  })
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
