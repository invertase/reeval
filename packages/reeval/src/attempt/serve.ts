import { connect } from 'node:net'

/** How long `c.serve` waits for the command to listen on a port. */
export const SERVE_TIMEOUT_MS = 120_000
/**
 * How long the new ports must stay the same before one that isn't `PORT` is taken, so a side
 * port (a debugger, an HMR socket) that binds first doesn't win over `PORT` binding later.
 */
export const SETTLE_MS = 3_000
const POLL_MS = 200
/** How many of the command's last lines an error shows. */
const OUTPUT_LINES = 20

/** A TCP listener in the sandbox's network namespace, from `/proc/net/tcp` or `tcp6`. */
export type Listener = { port: number; address: string }

/** One look at the sandbox's listeners and whether the served command still runs. */
export type ServeProbe =
  | { proc: false; alive: boolean }
  | { proc: true; alive: boolean; listeners: Listener[] }

/**
 * Prints `alive` while `pid` runs, then the sandbox's TCP tables, or `noproc` without them
 * (or without `tables`: the fake sandbox shares the host's, where other processes bind too).
 */
export function probeScript(pid?: string, tables = true): string {
  const alive = pid ? `kill -0 ${pid} 2>/dev/null && echo alive; ` : ''
  const read = tables
    ? 'if [ -r /proc/net/tcp ]; then cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; else echo noproc; fi'
    : 'echo noproc'
  return `${alive}${read}; exit 0`
}

/** `0100007F` → `127.0.0.1`; 32 hex digits → an IPv6 address. Each 32-bit word is host-endian. */
export function procAddress(hex: string): string {
  const bytes = (hex.match(/.{8}/g) ?? []).flatMap((w) =>
    (w.match(/../g) ?? []).reverse().map((b) => Number.parseInt(b, 16)),
  )
  if (bytes.length === 4) return bytes.join('.')
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12).join('.')
  }
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2)
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16))
  const full = groups.join(':')
  const longest = (full.match(/(^|:)0(:0)+(:|$)/g) ?? []).reduce(
    (a, b) => (b.length > a.length ? b : a),
    '',
  )
  return longest ? full.replace(longest, '::') : full
}

/** A listener the tunnel reaches: on loopback or every address, IPv4 or IPv6. */
const reachable = (address: string) =>
  address === '0.0.0.0' || address === '::' || address === '::1' || address.startsWith('127.')

export function parseProbe(stdout: string): ServeProbe {
  const lines = stdout.split('\n')
  const alive = lines.includes('alive')
  if (lines.includes('noproc')) return { proc: false, alive }
  const listeners: Listener[] = []
  for (const l of lines) {
    // `sl local remote st …`; state 0A is LISTEN.
    const m = /^\s*\d+:\s+([0-9A-F]+):([0-9A-F]{4})\s+\S+\s+0A\s/i.exec(l)
    const address = m ? procAddress(m[1] as string) : ''
    if (m && reachable(address))
      listeners.push({ port: Number.parseInt(m[2] as string, 16), address })
  }
  return { proc: true, alive, listeners }
}

/** The ports listening now that weren't before the command started, ascending. */
export const newPorts = (listeners: Listener[], before: ReadonlySet<number>) =>
  [...new Set(listeners.map((l) => l.port).filter((p) => !before.has(p)))].sort((a, b) => a - b)

/** What `c.serve` found: the port it serves on, or why there's none to pick. */
export type ServeDecision =
  | { kind: 'wait' }
  | { kind: 'port'; port: number; address: string }
  | { kind: 'several'; ports: number[] }
  | { kind: 'exited' }
  | { kind: 'timeout'; ports: number[] }

export type ServeState = {
  /** `PORT`, or the port the eval passed. */
  want: number
  /** The eval passed `want`: the command must listen on it, and no other port is taken. */
  given: boolean
  probe: ServeProbe & { proc: true }
  /** The ports that listened before the command started. */
  before: ReadonlySet<number>
  /** Since the new ports last changed, or the command started. */
  stableMs: number
  elapsedMs: number
  timeoutMs: number
}

/** The address to record for `port`: IPv4 first, since that's where the tunnel connects first. */
const addressFor = (listeners: Listener[], port: number) => {
  const all = listeners.filter((l) => l.port === port).map((l) => l.address)
  return all.find((a) => !a.includes(':')) ?? all.find((a) => a === '::') ?? all[0] ?? ''
}

/** `want` is taken whoever listens on it: `servePort` held it free when the command started. */
export function decide(s: ServeState): ServeDecision {
  const { listeners, alive } = s.probe
  const ports = newPorts(listeners, s.before)
  if (listeners.some((l) => l.port === s.want)) {
    return { kind: 'port', port: s.want, address: addressFor(listeners, s.want) }
  }
  const late = s.elapsedMs >= s.timeoutMs
  if (!s.given && ports.length && (s.stableMs >= SETTLE_MS || late || !alive)) {
    if (ports.length === 1) {
      const port = ports[0] as number
      return { kind: 'port', port, address: addressFor(listeners, port) }
    }
    return { kind: 'several', ports }
  }
  if (!alive) return { kind: 'exited' }
  return late ? { kind: 'timeout', ports } : { kind: 'wait' }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colors start with ESC
const plain = (output: string) => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

/** The URLs `output` prints on one of `ports`, as Vite's `Local: http://localhost:5173/`. */
export function printedUrls(output: string, ports: number[]): { url: string; port: number }[] {
  const found = new Map<string, number>()
  for (const m of plain(output).matchAll(
    /https?:\/\/(?:\[[0-9a-f:]+\]|[^\s/:[\]]+):(\d+)[^\s'"]*/gi,
  )) {
    const port = Number(m[1])
    if (ports.includes(port) && !found.has(m[0])) found.set(m[0], port)
  }
  return [...found].map(([url, port]) => ({ url, port }))
}

/** Whether something on the host accepts a TCP connection on `port`, IPv4 or IPv6 loopback. */
export async function hostListening(port: number): Promise<string | undefined> {
  for (const host of ['127.0.0.1', '::1']) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (ok) return host
  }
  return undefined
}

/** How many times `c.serve` allocates `PORT` again when the sandbox already listens on it. */
const ALLOCATE_TRIES = 5

/**
 * The port `c.serve` sets as `PORT` and waits on: `port`, or one from `allocate` that nothing
 * listens on yet. Throws when something already listens on `port`, since that server, not the
 * command's, would answer the checks: c.serve only stops what it started.
 */
export async function servePort(
  command: string,
  port: number | undefined,
  allocate: () => Promise<number>,
  taken: (port: number) => Promise<boolean>,
): Promise<number> {
  if (port === undefined) {
    for (let i = 0; i < ALLOCATE_TRIES; i++) {
      const want = await allocate()
      if (!(await taken(want))) return want
    }
    throw new Error(
      `c.serve(${JSON.stringify(command)}) found every port it allocated for PORT already in use in the sandbox`,
    )
  }
  if (await taken(port)) {
    throw new Error(
      `c.serve(${JSON.stringify(command)}, ${port}): port ${port} was already in use before c.serve started (a server the agent left running?), so the checks would reach that server, not this command's. Stop it first, or drop the port to serve on PORT`,
    )
  }
  return port
}

export type ServeFound = { port: number; address: string; detected: boolean; readyMs: number }

export type ServeWatch = {
  want: number
  given: boolean
  /** The ports that listened before the command started. */
  before: ReadonlySet<number>
  probe(): Promise<ServeProbe>
  /** What the command printed, or its end, for an error. */
  output(): Promise<string>
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Without `/proc`: the address the port accepts on, or undefined while nothing does. The
   * fake sandbox asks the host; a container with no `/proc` takes `want` on trust (`''`).
   */
  hostListening?: (port: number) => Promise<string | undefined>
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

const listOf = (items: Array<string | number>) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : String(items[0])

/**
 * Polls until something listens on `want`, or, without a given port, until the ports that are
 * new since the command started have settled on one. Throws, with the command's last output,
 * when they settle on several, it exits, or nothing listens in time.
 */
export async function awaitListening(command: string, w: ServeWatch): Promise<ServeFound> {
  const timeoutMs = w.timeoutMs ?? SERVE_TIMEOUT_MS
  const started = Date.now()
  let last = ''
  let changed = started
  const output = async () => plain(await w.output().catch(() => ''))
  const fail = async (why: string, out?: string) => {
    const tail = (out ?? (await output()))
      .trimEnd()
      .split('\n')
      .slice(-OUTPUT_LINES)
      .join('\n')
      .trim()
    return new Error(
      `c.serve(${JSON.stringify(command)}) ${why}${tail ? `. Its last output:\n${tail}` : ''}`,
    )
  }
  for (;;) {
    w.signal?.throwIfAborted()
    const probe = await w.probe()
    const now = Date.now()
    if (!probe.proc) {
      const address = await (w.hostListening ?? hostListening)(w.want)
      if (address !== undefined)
        return { port: w.want, address, detected: false, readyMs: now - started }
      if (!probe.alive) throw await fail(`exited before it listened on ${w.want}`)
      if (now - started >= timeoutMs) {
        throw await fail(
          `didn't listen on ${w.want} within ${timeoutMs / 1000}s. This sandbox can't list the ports it listens on, so it must listen on PORT or the port passed`,
        )
      }
    } else {
      const key = newPorts(probe.listeners, w.before).join(',')
      if (key !== last) {
        last = key
        changed = now
      }
      const d = decide({
        want: w.want,
        given: w.given,
        probe,
        before: w.before,
        stableMs: now - changed,
        elapsedMs: now - started,
        timeoutMs,
      })
      if (d.kind === 'port') {
        return {
          port: d.port,
          address: d.address,
          detected: d.port !== w.want,
          readyMs: now - started,
        }
      }
      if (d.kind === 'several') {
        const out = await output()
        const urls = printedUrls(out, d.ports)
        const printed = urls.length ? ` It printed ${listOf(urls.map((u) => u.url))}.` : ''
        const hint = urls[0]?.port ?? (d.ports[0] as number)
        throw await fail(
          `listens on ports ${listOf(d.ports)}, and not on PORT (${w.want}).${printed} Pass the one it serves on: c.serve(${JSON.stringify(command)}, ${hint})`,
          out,
        )
      }
      if (d.kind === 'exited') throw await fail('exited before it listened on a port')
      if (d.kind === 'timeout') {
        const on = d.ports.length
          ? `; ${d.ports.length > 1 ? 'ports' : 'port'} ${listOf(d.ports)} started listening`
          : ''
        throw await fail(
          `didn't listen on ${w.given ? `the port passed (${w.want})` : 'a port'} within ${timeoutMs / 1000}s${on}`,
        )
      }
    }
    await sleep(POLL_MS, w.signal)
  }
}
