import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shellQuote } from '@reeval/sandbox-docker/process'
import { hostModel } from '../analysis/model.ts'
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
import { startLoopbackProxy } from '../capture/loopback.ts'
import { stubPng } from '../capture/stub.ts'
import { captureUseSpend, runJourney } from '../capture/use.ts'
import { debugLog } from '../debug/attempt.ts'
import { untraced } from '../debug/docker.ts'
import { getRunContext, SUBJECT } from '../engine/runtime.ts'
import { gatewayScope, resolveModelGateway } from '../gateway/models.ts'
import { openRouterFallbacks } from '../gateway/openrouter-models.ts'
import { vertexSettingsIn } from '../gateway/vertex.ts'
import { sha256 } from '../ids.ts'
import { redactJson } from '../redact.ts'
import { cacheDir } from '../root.ts'
import { plural } from '../text.ts'
import type {
  BackgroundHandle,
  Capture,
  CaptureArtifactMeta,
  CaptureCall,
  CapturePage,
  CapturePageFile,
  CaptureUse,
  ServeHandle,
  ServeRecord,
} from '../types.ts'
import { addUsage } from '../usage.ts'
import { pageLines } from '../view/capture.ts'
import { asCheck, sandboxFor } from './checks.ts'
import { awaitListening, parseProbe, probeScript } from './serve.ts'
import type { Attempt } from './state.ts'

const BG_LOG = '/tmp/reeval-bg'
const BG_TAG = 'REEVAL_BACKGROUND'

export type CaptureArtifact = {
  name: string
  mediaType: 'image/png'
  sha256: string
  bytes: number
  capture: CaptureArtifactMeta
}

const isEvaluationModel = (model: string) => model.startsWith('typesafe-ai/')

const languageModel = (model: unknown) =>
  typeof model === 'string' && !isEvaluationModel(model) ? model : undefined

/**
 * `analysis.model`, else the attempt's judge (a profile's, group's or eval's over the config's),
 * whichever is first a language model.
 */
function defaultCaptureModel(a: Attempt): string | undefined {
  try {
    return languageModel(getRunContext().config.analysis.model) ?? languageModel(a.spec.judge.model)
  } catch {
    return undefined
  }
}

function resolveUse(
  a: Attempt,
  resolved: ResolvedCaptureCall,
  fakeSandbox: boolean,
): CaptureUse | undefined {
  if (resolved.fake) return { fake: resolved.fake }
  if (resolved.model) return { model: resolved.model }
  if (!resolved.instructions.length) return undefined
  const fallback = defaultCaptureModel(a)
  if (fallback) return { model: fallback }
  if (fakeSandbox) return undefined
  throw new Error(
    'c.capture() instructions need a vision model. Set capture.model, pass model on the call, or set analysis.model or the judge model to a language model that accepts images. Tests pass fakeInstructions from reeval/testing.',
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

type Started = {
  handle: BackgroundHandle
  /** The shell around the command. */
  pid: string
  /** Where the command's stdout and stderr go. */
  log: string
}

/** Starts `command` without waiting for exit. Teardown kills it if the eval didn't. */
export async function startBackground(
  a: Attempt,
  command: string,
  who: string,
  extraEnv: Record<string, string> = {},
): Promise<BackgroundHandle> {
  return (await launch(a, command, who, extraEnv)).handle
}

async function launch(
  a: Attempt,
  command: string,
  who: string,
  extraEnv: Record<string, string>,
): Promise<Started> {
  const box = await sandboxFor(a, who)
  // A shell of its own keeps a compound command's `&&`, `;` and redirects together, as in the
  // foreground; reeval's log only takes what the command leaves on stdout and stderr.
  const docker = a.spec.sandbox.kind === 'docker'
  const tag = randomUUID()
  const log = `${BG_LOG}-${tag.slice(0, 8)}.log`
  const wrapped = `${docker ? 'bash' : 'sh'} -c ${shellQuote(command)} >${log} 2>&1 & echo $$ $!`
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
      await box.exec(`${tree}; kill -9 ${pid} 2>/dev/null; rm -f ${log}; true`).catch(() => {})
    },
  }
  a.backgrounds.push(handle)
  return { handle, pid, log }
}

/**
 * Starts `command` with `PORT` set and returns once it listens: on `PORT` (or `port`), else on
 * the one port that wasn't listening before it started, which it records.
 */
export async function serveCommand(
  a: Attempt,
  command: string,
  port?: number,
): Promise<ServeHandle> {
  const want = port ?? (await allocatePort())
  const box = await sandboxFor(a, 'c.serve()')
  const tables = a.spec.sandbox.kind !== 'fake'
  const look = (pid?: string) =>
    untraced(() => box.exec(probeScript(pid, tables), { signal: a.signal })).then((r) =>
      parseProbe(r.stdout),
    )
  const first = await look()
  const before = new Set(first.proc ? first.listeners.map((l) => l.port) : [])
  const { handle, pid, log } = await launch(a, command, 'c.serve()', { PORT: String(want) })
  const found = await awaitListening(command, {
    want,
    given: port !== undefined,
    before,
    signal: a.signal,
    probe: () => look(pid),
    output: async () => (await box.exec(`tail -c 65536 ${log} 2>/dev/null`)).stdout,
    ...(tables ? { hostListening: async () => '' } : {}),
  }).catch(async (error: Error) => {
    await handle.kill()
    throw error
  })
  const serve: ServeRecord = {
    command,
    port: found.port,
    portEnv: want,
    detected: found.detected,
    address: found.address,
    readyMs: found.readyMs,
  }
  a.record.serves = [...(a.record.serves ?? []), serve]
  const at = found.address ? `${found.address} ` : ''
  debugLog(
    'check',
    found.detected
      ? `c.serve ${command}: listening on ${at}port ${found.port}, not PORT ${want}; using ${found.port}`
      : `c.serve ${command}: listening on ${at}port ${found.port} after ${found.readyMs}ms`,
  )
  return { ...handle, port: found.port }
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
  const tunnel = box.getPortEndpoint?.bind(box)
  if (!tunnel) {
    throw new Error('c.capture() needs a sandbox that can tunnel a port')
  }
  const { url: origin } = await tunnel({
    port: resolved.port,
    protocol: 'http',
  })
  try {
    await pollHttp(pageUrl(origin, '/'), resolved.timeoutMs, a.signal)
  } catch {
    throw new Error(`nothing listening on port ${resolved.port}`)
  }
  const fake = a.spec.sandbox.kind === 'fake'
  const use = resolveUse(a, resolved, fake)
  a.captureNames.add(resolved.name)
  const started = Date.now()
  const remaining = () => Math.max(0, resolved.timeoutMs - (Date.now() - started))
  let moves = 0
  const url = pageUrl(origin, resolved.path)
  const { png, page } = fake
    ? {
        png: stubPng(resolved.name, resolved.port, resolved.path, resolved.viewport),
        page: await fetchedPage(url, origin, remaining(), a.signal),
      }
    : await shot(
        a,
        origin,
        url,
        { ...resolved, use },
        remaining,
        (n) => {
          moves = n
        },
        (port) => tunnel({ port, protocol: 'http' }).then((t) => t.url),
      )
  tracePage(resolved.name, page)
  const facts: CapturePageFile = { schemaVersion: 1, ...page }
  const pageJson = `${redactJson(facts, 2)}\n`
  a.capturePages.set(resolved.name, pageJson)
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
    ...(page.status ? { status: page.status } : {}),
    ...(page.errors.length ? { pageErrors: page.errors.length } : {}),
    page: {
      path: `artifacts/${resolved.name}.capture.json`,
      sha256: sha256(pageJson),
      bytes: Buffer.byteLength(pageJson),
    },
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
  const taken: Capture = {
    name: resolved.name,
    port: resolved.port,
    path: resolved.path,
    viewport: resolved.viewport,
    file,
    ...structuredClone(page),
  }
  // Names it in a matcher's default label: `toHaveNoPageErrors home`.
  return Object.defineProperty(taken, SUBJECT, { value: resolved.name })
}

/** The fake sandbox has no browser: the page's status and final URL from a GET, and no more. */
async function fetchedPage(
  url: string,
  origin: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CapturePage> {
  const res = await fetch(url, {
    signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, timeoutMs)), signal]),
  }).catch(() => undefined)
  await res?.body?.cancel()
  const base = origin.replace(/\/$/, '')
  const final = res?.url || url
  return {
    ...(res ? { status: res.status } : {}),
    finalUrl: final.startsWith(base) ? final.slice(base.length) || '/' : final,
    console: [],
    errors: [],
    failedRequests: [],
  }
}

/** The page's facts in the debug log, which `-v` prints: a summary, then a line each. */
function tracePage(name: string, page: CapturePage) {
  const counts = [
    plural(page.errors.length, 'page error'),
    plural(page.console.length, 'console message'),
    plural(page.failedRequests.length, 'failed request'),
  ]
  const status = page.status ? ` (${page.status})` : ''
  debugLog('check', `capture "${name}" at ${page.finalUrl}${status}: ${counts.join(' · ')}`)
  for (const line of pageLines(page)) debugLog('check', `capture "${name}" ${line}`)
}

async function shot(
  a: Attempt,
  origin: string,
  url: string,
  resolved: ResolvedCaptureCall & { use?: CaptureUse },
  remaining: () => number,
  onMoves: (n: number) => void,
  tunnel: (port: number) => Promise<string>,
): Promise<{ png: Buffer; page: CapturePage }> {
  const cache = cacheDir()
  const bin = await ensureChrome(cache, {
    cacheLabel: cacheLabel(cache),
    signal: a.signal,
    onProgress: (p) => a.report({ kind: 'browser-download', ...p }),
  })
  // The browser runs on the host: the page's own loopback requests (an emulator, an API on
  // another port) mean the sandbox's, so they go through its tunnels.
  const proxy = await startLoopbackProxy({ tunnel, direct: [Number(new URL(url).port)] })
  const browser = { proxy: proxy.address }
  return withChrome(
    bin,
    resolved.window,
    remaining(),
    browser,
    async (session) => {
      const journey = runJourney(session, url, {
        wait: resolved.wait,
        timeoutMs: remaining(),
        budgetMs: resolved.timeoutMs,
        fullPage: resolved.fullPage,
        instructions: resolved.instructions,
        use: resolved.use,
        remaining,
        loadModel: async (name) => {
          const { config, profile } = getRunContext()
          const scope = gatewayScope(config, profile)
          const gateway = resolveModelGateway(name, undefined, scope, 'capture model')
          return hostModel(name, gateway, 'capture model', {
            fallbacks: openRouterFallbacks(scope.gateways),
            ...(gateway === 'vertex' ? { vertex: vertexSettingsIn(scope.gateways) } : {}),
          })
        },
      })
      // A wait that never ends is often the app failing: trace what the page said before throwing.
      const result = await journey.catch(async (error: unknown) => {
        const page = await session.page(origin).catch(() => undefined)
        if (page) tracePage(resolved.name, page)
        throw error
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
      return { png: result.png, page: await session.page(origin) }
    },
    a.signal,
  ).finally(async () => {
    await proxy.close()
    if (proxy.reached.length) {
      debugLog(
        'check',
        `c.capture ${resolved.name}: sandbox port ${proxy.reached.join(', ')} answered the page through its tunnel`,
      )
    }
  })
}

/** Writes PNG sidecars next to the staging eval JSON so redact never sees the bytes. */
export async function writeCaptureSidecars(
  stagingDir: string,
  recordFile: string,
  blobs: Map<string, Buffer>,
  pages: Map<string, string>,
): Promise<void> {
  if (blobs.size === 0) return
  const dir = join(stagingDir, 'evals', recordFile.replace(/\.json$/, '.artifacts'))
  await mkdir(dir, { recursive: true })
  for (const [name, png] of blobs) await writeFile(join(dir, `${name}.png`), png)
  for (const [name, json] of pages) await writeFile(join(dir, `${name}.capture.json`), json)
}
