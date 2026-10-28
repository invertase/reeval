import { connect } from 'node:net'
import { shellQuote } from '@reeval/sandbox-docker/process'

/** How long `c.serve` waits for the command to listen on a port. */
export const SERVE_TIMEOUT_MS = 120_000
/**
 * How long the command's ports must stay the same before one that isn't `PORT` is taken, so a
 * side port (a debugger, an HMR socket) that binds first doesn't win over `PORT` binding later.
 */
export const SETTLE_MS = 3_000
const POLL_MS = 200

/**
 * A TCP listener in the sandbox's network namespace, from `/proc/net/tcp` or `tcp6`; `own` when
 * the served command's process tree holds its socket.
 */
export type Listener = { port: number; address: string; inode: string; own: boolean }

/** One look at the served command's process tree and what it listens on. */
export type ServeProbe =
  | { proc: false; alive: boolean }
  | { proc: true; alive: boolean; listeners: Listener[] }

/**
 * Prints the served command's process tree and its sockets, and the sandbox's TCP listeners.
 * The tree is `pid` and its descendants by `ppid` and, with `tag`, every process whose
 * environment carries it, so one the command left behind as it exited still counts.
 * Shell builtins plus `ls`, so it runs in any image with a shell.
 */
export function probeScript(pid: string, tag?: string): string {
  const tagged = tag
    ? `for e in $procs; do p=\${e%%:*}; tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qxF ${shellQuote(tag)} && case "$todo" in *" $p "*) ;; *) todo="$todo$p " ;; esac; done`
    : ''
  return `[ -r /proc/net/tcp ] || { kill -0 ${pid} 2>/dev/null && echo noproc 1 || echo noproc 0; exit 0; }
procs=
for f in /proc/[0-9]*/stat; do
  { read -r s < "$f"; } 2>/dev/null || continue
  p=\${f#/proc/}; p=\${p%/stat}
  set -- \${s##*) }
  [ "$1" = Z ] && continue
  procs="$procs $p:$2"
done
todo=" "
case "$procs " in *" ${pid}:"*) todo=" ${pid} " ;; esac
${tagged}
all=" "
while [ "$todo" != " " ]; do
  all="$all\${todo# }"
  next=" "
  for e in $procs; do
    p=\${e%%:*}; pp=\${e#*:}
    case "$todo" in *" $pp "*) case "$all$next" in *" $p "*) ;; *) next="$next$p " ;; esac ;; esac
  done
  todo=$next
done
echo "tree$all"
for p in $all; do ls -l /proc/$p/fd 2>/dev/null; done
for t in tcp tcp6; do
  [ -r /proc/net/$t ] || continue
  while read -r _ local _ st _ _ _ _ _ inode _; do
    [ "$st" = 0A ] && echo "listen $local $inode"
  done < /proc/net/$t
done
exit 0`
}

/** `0100007F` → `127.0.0.1`; 32 hex digits → an IPv6 address. Each 32-bit word is host-endian. */
export function procAddress(hex: string): string {
  const words = hex.match(/.{8}/g) ?? []
  const bytes = words.flatMap((w) =>
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
  const zeros = full.match(/(^|:)0(:0)+(:|$)/g)
  if (!zeros) return full
  const longest = zeros.reduce((a, b) => (b.length > a.length ? b : a))
  return full.replace(longest, '::')
}

/** A listener the tunnel reaches: on loopback or every address, IPv4 or IPv6. */
const reachable = (address: string) =>
  address === '0.0.0.0' || address === '::' || address === '::1' || address.startsWith('127.')

export function parseProbe(stdout: string): ServeProbe {
  const lines = stdout.split('\n')
  const noproc = lines.find((l) => l.startsWith('noproc '))
  if (noproc) return { proc: false, alive: noproc.endsWith(' 1') }
  const tree =
    lines
      .find((l) => l.startsWith('tree'))
      ?.slice(4)
      .trim() ?? ''
  const sockets = new Set(
    lines.flatMap((l) => [...l.matchAll(/socket:\[(\d+)\]/g)].map((m) => m[1] as string)),
  )
  const listeners: Listener[] = []
  for (const l of lines) {
    const m = /^listen ([0-9A-F]+):([0-9A-F]{4}) (\d+)$/i.exec(l.trim())
    if (!m) continue
    const address = procAddress(m[1] as string)
    if (reachable(address)) {
      const inode = m[3] as string
      listeners.push({
        port: Number.parseInt(m[2] as string, 16),
        address,
        inode,
        own: sockets.has(inode),
      })
    }
  }
  return { proc: true, alive: tree !== '', listeners }
}

/** The ports the command's own processes listen on, ascending, once each. */
export const portsOf = (listeners: Listener[]) =>
  [...new Set(listeners.filter((l) => l.own).map((l) => l.port))].sort((a, b) => a - b)

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
  /** Since the listening ports last changed, or the command started. */
  stableMs: number
  elapsedMs: number
  timeoutMs: number
}

/** The address to record for `port`: IPv4 first, since that's where the tunnel connects first. */
const addressFor = (listeners: Listener[], port: number) => {
  const all = listeners.filter((l) => l.port === port).map((l) => l.address)
  return all.find((a) => !a.includes(':')) ?? all.find((a) => a === '::') ?? all[0] ?? ''
}

/**
 * `want` is taken whoever listens on it: reeval allocated it, or the eval named it, and a
 * command that forks its server away (`node server.js &`, a daemon) leaves no tree to own it.
 */
export function decide(s: ServeState): ServeDecision {
  const { listeners, alive } = s.probe
  const ports = portsOf(listeners)
  if (listeners.some((l) => l.port === s.want)) {
    return { kind: 'port', port: s.want, address: addressFor(listeners, s.want) }
  }
  if (!alive) return { kind: 'exited' }
  const late = s.elapsedMs >= s.timeoutMs
  if (!s.given && ports.length && (s.stableMs >= SETTLE_MS || late)) {
    if (ports.length === 1) {
      const port = ports[0] as number
      return { kind: 'port', port, address: addressFor(listeners, port) }
    }
    return { kind: 'several', ports }
  }
  return late ? { kind: 'timeout', ports } : { kind: 'wait' }
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

export type ServeFound = { port: number; address: string; detected: boolean; readyMs: number }

export type ServeWatch = {
  want: number
  given: boolean
  probe(): Promise<ServeProbe>
  /** The last lines the command printed, for an error. */
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

const listOf = (ports: number[]) =>
  ports.length > 1 ? `${ports.slice(0, -1).join(', ')} and ${ports.at(-1)}` : String(ports[0])

/**
 * Polls the served command until something listens on `want`, or, without a given port, until
 * its own processes have settled on one other port. Throws, with the command's last output, when
 * they settle on several others, it exits, or nothing listens in time.
 */
export async function awaitListening(command: string, w: ServeWatch): Promise<ServeFound> {
  const timeoutMs = w.timeoutMs ?? SERVE_TIMEOUT_MS
  const started = Date.now()
  let last = ''
  let changed = started
  const fail = async (why: string) => {
    const out = (await w.output().catch(() => '')).trim()
    return new Error(
      `c.serve(${JSON.stringify(command)}) ${why}${out ? `. Its last output:\n${out}` : ''}`,
    )
  }
  const portHint = (port: number) => `c.serve(${JSON.stringify(command)}, ${port})`
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
          `didn't listen on ${w.want} within ${timeoutMs / 1000}s. This sandbox has no /proc to read the ports it listens on, so it must listen on PORT or the port passed`,
        )
      }
    } else {
      const key = portsOf(probe.listeners).join(',')
      if (key !== last) {
        last = key
        changed = now
      }
      const d = decide({
        want: w.want,
        given: w.given,
        probe,
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
        throw await fail(
          `listens on ports ${listOf(d.ports)}, and not on PORT (${w.want}). Pass the one it serves on: ${portHint(d.ports[0] as number)}`,
        )
      }
      if (d.kind === 'exited') throw await fail('exited before it listened on a port')
      if (d.kind === 'timeout') {
        const on = d.ports.length
          ? `; it listens on ${d.ports.length > 1 ? 'ports' : 'port'} ${listOf(d.ports)}`
          : ''
        throw await fail(
          `didn't listen on ${w.given ? `the port passed (${w.want})` : 'a port'} within ${timeoutMs / 1000}s${on}`,
        )
      }
    }
    await sleep(POLL_MS, w.signal)
  }
}
