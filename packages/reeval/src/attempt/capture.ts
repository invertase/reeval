import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shellQuote } from '@reeval/sandbox-docker/process'
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
import { gatewayScope, resolveModelGateway } from '../gateway/models.ts'
import { vertexSettingsIn } from '../gateway/vertex.ts'
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
import { asCheck, sandboxFor } from './checks.ts'
import type { Attempt } from './state.ts'

const BG_LOG = '/tmp/reeval-bg.log'
const BG_TAG = 'REEVAL_BACKGROUND'

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
    'c.capture() instructions need a vision model. Set capture.model, pass model on the call, or analysis.model to a language model that accepts images. Tests pass fakeInstructions from reeval/testing.',
  )
}

/**
 * Stops `pid` and its descendants under Git for Windows' MSYS. Native children (node.exe) are
 * MSYS processes too, in /proc with their `ppid` and Win32 `winpid`, but their Windows parent is
 * gone after MSYS's fork and exec, so `taskkill /T` from the shell doesn't reach them, and a signal
 * alone doesn't stop them. So collect the tree by `ppid` first (a kill reparents), then `taskkill`
 * each Win32 pid and SIGKILL its MSYS process; the group kill catches anything the walk raced.
 */
export function msysTreeKill(pid: string, group: string, proc = '/proc'): string {
  return `all=${pid}; todo=" ${pid} "
while [ "$todo" != " " ]; do
  next=" "
  for f in ${proc}/[0-9]*/ppid; do
    { read -r pp < "$f"; } 2>/dev/null || continue
    p=\${f#${proc}/}; p=\${p%/ppid}
    case "$todo" in *" $pp "*) case " $all " in *" $p "*) ;; *) all="$all $p"; next="$next$p " ;; esac ;; esac
  done
  todo=$next
done
for p in $all; do
  wp=$(tr -d '\\r\\n' < ${proc}/$p/winpid 2>/dev/null) && taskkill /F /PID "$wp" >/dev/null 2>&1
  kill -9 "$p" 2>/dev/null
done
kill -9 -${group} 2>/dev/null`
}

/** Starts `command` without waiting for exit. Teardown kills it if the eval didn't. */
export async function startBackground(
  a: Attempt,
  command: string,
  who: string,
  extraEnv: Record<string, string> = {},
): Promise<BackgroundHandle> {
  const box = await sandboxFor(a, who)
  // A shell of its own keeps a compound command's `&&`, `;` and redirects together, as in the
  // foreground; reeval's log only takes what the command leaves on stdout and stderr.
  const docker = a.spec.sandbox.kind === 'docker'
  const wrapped = `${docker ? 'bash' : 'sh'} -c ${shellQuote(command)} >${BG_LOG} 2>&1 & echo $$ $!`
  const tag = randomUUID()
  const r = await asCheck(a, () =>
    box.exec(wrapped, {
      signal: a.signal,
      env: { ...(a.env?.checkVars ?? {}), ...extraEnv, ...(docker ? { [BG_TAG]: tag } : {}) },
    }),
  )
  const [group = '', pid = ''] = r.stdout.trim().split(/\s+/).slice(-2)
  if (!/^\d+$/.test(pid) || !/^\d+$/.test(group)) {
    throw new Error(
      `c.exec({ background: true }) did not start (no pid):\n${(r.stderr || r.stdout).trim()}`,
    )
  }
  // The pid is the shell around the command (dash and bash run a compound one as its child), so
  // kill() also stops everything under it.
  const tree = docker
    ? // Docker runs the command in a container with a /proc: everything that inherited the tag.
      `for e in /proc/[0-9]*/environ; do grep -qsxzF ${shellQuote(`${BG_TAG}=${tag}`)} "$e" && kill -9 "$(basename "$(dirname "$e")")" 2>/dev/null; done`
    : process.platform === 'win32'
      ? msysTreeKill(pid, group)
      : // The fake sandbox spawns each exec detached, so its shell (`$$`) leads a process group
        // the command and all it started belong to. dash's kill takes no `--`.
        `kill -9 -${group} 2>/dev/null`
  let killed = false
  const handle: BackgroundHandle = {
    async kill() {
      if (killed) return
      killed = true
      // Do not pass a.signal: after a timeout it is already aborted, and run() would skip the kill.
      // The tree first: Windows reads the Win32 pid from /proc/<pid>, gone once the pid is.
      await box.exec(`${tree}; kill -9 ${pid} 2>/dev/null; true`).catch(() => {})
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
  const handle = await startBackground(a, command, 'c.serve()', { PORT: String(bound) })
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
  const box = await sandboxFor(a, 'c.capture()')
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
        const { config, profile } = getRunContext()
        const scope = gatewayScope(config, profile)
        const gateway = resolveModelGateway(name, undefined, scope, 'capture model')
        const route = judgeRoute(name, process.env, 'capture model', gateway).kind
        return providerModel({
          name,
          route,
          ...(route === 'vertex' ? { vertex: vertexSettingsIn(scope.gateways) } : {}),
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
