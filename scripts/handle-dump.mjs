// Preloaded with NODE_OPTIONS=--import in CI's Podman job, to name what keeps a process alive.
// Every process prints its active handles and requests once it has run REEVAL_HANDLE_DUMP_MS
// (5 minutes). A `node --test` file also gets a watchdog: if its process is still alive
// REEVAL_HANDLE_WATCHDOG_MS (60 s) after its tests finished, it prints them and exits 1, so the
// file fails naming the handle instead of the job running into its timeout. Each dump also goes
// to REEVAL_HANDLE_DUMP_DIR/<pid>.txt, when set, for a later step to print.
import childProcess, { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DUMP_MS = Number(process.env.REEVAL_HANDLE_DUMP_MS ?? 300_000)
const WATCHDOG_MS = Number(process.env.REEVAL_HANDLE_WATCHDOG_MS ?? 60_000)
const DIR = process.env.REEVAL_HANDLE_DUMP_DIR
const started = Date.now()

// A child's stdio pipes outlive its handle once it exits, so each remembers who opened it.
const spawnOf = new WeakMap()
const { spawn } = childProcess.ChildProcess.prototype
childProcess.ChildProcess.prototype.spawn = function (...args) {
  const r = spawn.apply(this, args)
  for (const s of this.stdio ?? []) if (s) spawnOf.set(s, { pid: this.pid, args: this.spawnargs })
  return r
}

const address = (a) => (a && typeof a === 'object' ? `${a.address}:${a.port}` : String(a))
const short = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s)

function describe(h) {
  const name = h?.constructor?.name ?? typeof h
  const own = ['stdin', 'stdout', 'stderr'].find((s) => process[s] === h)
  if (own) return `${name} (this process's ${own})`
  try {
    if (name === 'ChildProcess') {
      return `ChildProcess pid=${h.pid} exitCode=${h.exitCode} signal=${h.signalCode} ${short(h.spawnargs.join(' '))}`
    }
    if (name === 'Timeout') {
      return `Timeout ${h._idleTimeout}ms repeat=${h._repeat} ${short(String(h._onTimeout))}`
    }
    if (typeof h?.listen === 'function' && typeof h?.address === 'function') {
      return `${name} listening=${h.listening} on ${address(h.address())} connections=${h._connections}`
    }
    if (typeof h?.remoteAddress !== 'undefined' || h?._handle) {
      const spawned = spawnOf.get(h)
      const kind = h._handle?.constructor?.name
      const ends = `local=${h.localAddress}:${h.localPort} remote=${h.remoteAddress}:${h.remotePort}`
      const server = h.server ?? h._server
      const state = `readable=${h.readable} writable=${h.writable} readableEnded=${h.readableEnded} writableEnded=${h.writableEnded} destroyed=${h.destroyed}`
      return [
        `${name}(${kind})`,
        spawned ? `stdio of pid ${spawned.pid}: ${short(spawned.args.join(' '))}` : ends,
        server ? `accepted by ${server.constructor?.name} on ${address(server.address?.())}` : '',
        state,
      ]
        .filter(Boolean)
        .join(' ')
    }
    return name
  } catch (error) {
    return `${name} (couldn't describe: ${error.message})`
  }
}

function dump(why) {
  const lines = [
    `reeval handle dump: pid ${process.pid} (${short(process.argv.slice(1).join(' '))}), ${why}, ${Math.round((Date.now() - started) / 1000)}s in`,
    `resources: ${process.getActiveResourcesInfo().join(', ')}`,
    'handles:',
    ...process._getActiveHandles().map((h) => `  ${describe(h)}`),
    'requests:',
    ...process._getActiveRequests().map((r) => `  ${r?.constructor?.name}`),
  ]
  try {
    const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,etime=,args='], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const rows = ps
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((r) => r.length > 5)
    const ours = new Set([String(process.pid)])
    for (let grew = true; grew; ) {
      grew = false
      for (const [pid, ppid] of rows) {
        if (ours.has(ppid) && !ours.has(pid)) grew = ours.add(pid)
      }
    }
    lines.push(
      "processes (this one, its descendants and the engine's own):",
      '  PID PPID PGID STAT ELAPSED ARGS',
      ...rows
        .filter((r) => ours.has(r[0]) || /podman|conmon|pasta|slirp4netns|rootlessport/.test(r[5]))
        .map((r) => `  ${r.slice(0, 5).join(' ')} ${short(r.slice(5).join(' '))}`),
    )
  } catch {}
  const text = `${lines.join('\n')}\n`
  process.stderr.write(text)
  if (DIR) {
    try {
      mkdirSync(DIR, { recursive: true })
      appendFileSync(join(DIR, `${process.pid}.txt`), text)
    } catch {}
  }
}

setTimeout(() => dump(`still running after ${DUMP_MS / 1000}s`), DUMP_MS).unref()

if (process.env.NODE_TEST_CONTEXT && /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  const { after } = await import('node:test')
  after(() => {
    setTimeout(() => {
      dump(`still alive ${WATCHDOG_MS / 1000}s after its tests finished`)
      process.exit(1)
    }, WATCHDOG_MS).unref()
  })
}
