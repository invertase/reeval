#!/usr/bin/env node
// reeval's MCP start-up timer, in the sandbox as bin/mcp-timer.cjs:
//
//   node mcp-timer.cjs --name <server> -- <command> [args…]
//
// It runs the stdio MCP server with stdin, stdout and stderr passed through untouched, and appends
// one JSON line to mcp-startup.jsonl, beside its bin/ directory:
//   { server, spawnedAt, initializedAt }    the server answered the client's `initialize`
//   { server, spawnedAt, timeout: true }    it hadn't within 60s: the server is killed, exit 1
//   { server, spawnedAt, exitCode }         it exited before answering
//   { server, spawnedAt, closed: true }     the client closed stdin first, and the server neither
//                                           answered nor exited within a second: not a timeout
//   { server, spawnedAt, unread: true }     more than SCAN_LIMIT went by unframed: not timed
// Times are epoch milliseconds. A timer killed outright (SIGKILL) logs nothing. MCP's stdio
// transport is newline-delimited JSON-RPC; messages framed with Content-Length headers (LSP style)
// are read too.
'use strict'
const { spawn } = require('node:child_process')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')

const TIMEOUT_MS = 60_000
/** How long after the client closes stdin the server's own exit or answer is awaited for the log. */
const CLOSE_GRACE_MS = 1_000
/** Bytes a direction may buffer while the handshake is still awaited, before it gives up reading. */
const SCAN_LIMIT = 4 * 1024 * 1024

/**
 * A reader of one direction's JSON-RPC stream: `push` each chunk, and `onMessage` gets every
 * message (each element of a batch) as it completes. Lines that aren't JSON are skipped. Past
 * SCAN_LIMIT bytes of one unfinished message it stops reading and calls `onGiveUp`.
 */
function scanner(onMessage, onGiveUp = () => {}) {
  let buffer = Buffer.alloc(0)
  let stopped = false
  const emit = (text) => {
    let value
    try {
      value = JSON.parse(text)
    } catch {
      return
    }
    for (const m of Array.isArray(value) ? value : [value]) {
      if (m && typeof m === 'object') onMessage(m)
    }
  }
  const next = () => {
    let start = 0
    while (start < buffer.length && /\s/.test(String.fromCharCode(buffer[start]))) start++
    const rest = buffer.subarray(start)
    if (/^content-length:/i.test(rest.subarray(0, 15).toString('latin1'))) {
      const crlf = rest.indexOf('\r\n\r\n')
      const lf = rest.indexOf('\n\n')
      const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf >= 0 ? lf + 2 : -1
      if (end < 0) return false
      const length = Number(/content-length:\s*(\d+)/i.exec(rest.subarray(0, end).toString())?.[1])
      if (!Number.isFinite(length) || rest.length < end + length) return false
      emit(rest.subarray(end, end + length).toString('utf8'))
      buffer = rest.subarray(end + length)
      return true
    }
    const newline = rest.indexOf('\n')
    if (newline < 0) return false
    emit(rest.subarray(0, newline).toString('utf8'))
    buffer = rest.subarray(newline + 1)
    return true
  }
  return {
    push(chunk) {
      if (stopped) return
      buffer = Buffer.concat([buffer, chunk])
      while (!stopped && next()) {}
      if (!stopped && buffer.length > SCAN_LIMIT) {
        stopped = true
        buffer = Buffer.alloc(0)
        onGiveUp()
      }
    },
    stop() {
      stopped = true
      buffer = Buffer.alloc(0)
    },
  }
}

/**
 * Watches both directions for the handshake: the client's `initialize` request, then the server's
 * answer (result or error) to its id. `onInitialized` is called once, or else `onUnread` once, if
 * either direction's scanner gives up first.
 */
function handshake(onInitialized, onUnread = () => {}) {
  let id
  let done = false
  const finish = (then) => {
    if (done) return
    done = true
    client.stop()
    server.stop()
    then()
  }
  const server = scanner(
    (m) => {
      if (id === undefined || m.id !== id || !('result' in m || 'error' in m)) return
      finish(onInitialized)
    },
    () => finish(onUnread),
  )
  const client = scanner(
    (m) => {
      if (id === undefined && m.method === 'initialize' && m.id !== undefined) id = m.id
    },
    () => finish(onUnread),
  )
  return { fromClient: (chunk) => client.push(chunk), fromServer: (chunk) => server.push(chunk) }
}

/**
 * Starts the server and calls `wire` with it. On Windows (the fake sandbox, on the host) Node can't
 * spawn what the POSIX shell the client used would run, such as `npx` (a `.cmd`) or `sh`, so those
 * go through `sh`.
 */
function start(command, args, wire) {
  const options = { stdio: ['pipe', 'pipe', 'inherit'] }
  const child = spawn(command, args, options)
  if (process.platform !== 'win32') return wire(child)
  child.once('spawn', () => wire(child))
  child.once('error', (error) => {
    if (error.code !== 'ENOENT' && error.code !== 'EINVAL') return wire(null, error)
    wire(spawn('sh', ['-c', 'exec "$0" "$@"', command, ...args], options))
  })
}

/** The shell's status for a command it couldn't run. */
const NOT_STARTED = 127

function main(argv) {
  const at = argv.indexOf('--')
  const flags = at < 0 ? argv : argv.slice(0, at)
  const name = flags[flags.indexOf('--name') + 1]
  const [command, ...args] = at < 0 ? [] : argv.slice(at + 1)
  if (flags.indexOf('--name') < 0 || !name || !command) {
    process.stderr.write('usage: node mcp-timer.cjs --name <server> -- <command> [args…]\n')
    process.exit(2)
  }
  const spawnedAt = Date.now()
  let settled = false
  /** Logs the start's outcome, once. */
  const settle = (entry) => {
    if (settled) return false
    settled = true
    clearTimeout(timer)
    try {
      appendFileSync(
        join(__dirname, '..', 'mcp-startup.jsonl'),
        `${JSON.stringify({ server: name, spawnedAt, ...entry })}\n`,
      )
    } catch {}
    return true
  }
  const watch = handshake(
    () => settle({ initializedAt: Date.now() }),
    () => settle({ unread: true }),
  )
  /** The server, once it has started; until then the client's input waits in `pending`. */
  let child
  let pending = []
  let ended = false
  const timer = setTimeout(() => {
    if (!settle({ timeout: true })) return
    process.stderr.write(
      `reeval: MCP server ${name} didn't answer initialize within ${TIMEOUT_MS / 1000}s\n`,
    )
    child?.kill('SIGKILL')
    process.exit(1)
  }, TIMEOUT_MS)
  process.stdin.on('data', (chunk) => {
    if (child) child.stdin.write(chunk)
    else pending.push(chunk)
    watch.fromClient(chunk)
  })
  process.stdin.on('end', () => {
    ended = true
    child?.stdin.end()
    // A server that exits on it (or answers at once) is logged as such; the timeout is off.
    clearTimeout(timer)
    setTimeout(() => settle({ closed: true }), CLOSE_GRACE_MS).unref()
  })
  process.stdout.on('error', () => child?.kill())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => (child ? child.kill(signal) : process.exit(128)))
  }
  start(command, args, (started, failure) => {
    if (!started) {
      process.stderr.write(`reeval: couldn't start MCP server ${name}: ${failure.message}\n`)
      settle({ exitCode: NOT_STARTED })
      process.exit(NOT_STARTED)
    }
    child = started
    child.on('error', (error) => {
      process.stderr.write(`reeval: couldn't start MCP server ${name}: ${error.message}\n`)
    })
    child.stdin.on('error', () => {})
    for (const chunk of pending) child.stdin.write(chunk)
    pending = []
    if (ended) child.stdin.end()
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      watch.fromServer(chunk)
    })
    child.on('close', (code, signal) => {
      const status =
        code === null
          ? 128 + (require('node:os').constants.signals[signal] ?? 1)
          : code < 0
            ? NOT_STARTED
            : code
      settle({ exitCode: code === null ? null : status })
      process.stdout.write('', () => process.exit(status))
    })
  })
}

if (require.main === module) main(process.argv.slice(2))
else module.exports = { scanner, handshake }
