#!/usr/bin/env node
// reeval's MCP start-up timer, in the sandbox as bin/mcp-timer.cjs:
//
//   mcp-timer.cjs --name <server> -- <command> [args…]
//
// It runs the stdio MCP server with stdin, stdout and stderr passed through untouched, and appends
// one JSON line to mcp-startup.jsonl, beside its bin/ directory:
//   { server, spawnedAt, initializedAt }    the server answered the client's `initialize`
//   { server, spawnedAt, timeout: true }    it hadn't within 60s: the server is killed, exit 1
//   { server, spawnedAt, exitCode }         it exited before answering
// Times are epoch milliseconds. MCP's stdio transport is newline-delimited JSON-RPC; messages framed
// with Content-Length headers (LSP style) are read too.
'use strict'
const { spawn } = require('node:child_process')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')

const TIMEOUT_MS = 60_000
/** Bytes a direction may buffer while the handshake is still awaited, before it gives up reading. */
const SCAN_LIMIT = 4 * 1024 * 1024

/**
 * A reader of one direction's JSON-RPC stream: `push` each chunk, and `onMessage` gets every
 * message (each element of a batch) as it completes. Lines that aren't JSON are skipped.
 */
function scanner(onMessage) {
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
      if (buffer.length > SCAN_LIMIT) stopped = true
    },
    stop() {
      stopped = true
      buffer = Buffer.alloc(0)
    },
  }
}

/**
 * Watches both directions for the handshake: the client's `initialize` request, then the server's
 * answer (result or error) to its id. `onInitialized` is called once.
 */
function handshake(onInitialized) {
  let id
  let done = false
  const server = scanner((m) => {
    if (done || id === undefined || m.id !== id || !('result' in m || 'error' in m)) return
    done = true
    client.stop()
    server.stop()
    onInitialized()
  })
  const client = scanner((m) => {
    if (id === undefined && m.method === 'initialize' && m.id !== undefined) id = m.id
  })
  return { fromClient: (chunk) => client.push(chunk), fromServer: (chunk) => server.push(chunk) }
}

function main(argv) {
  const at = argv.indexOf('--')
  const flags = at < 0 ? argv : argv.slice(0, at)
  const name = flags[flags.indexOf('--name') + 1]
  const [command, ...args] = at < 0 ? [] : argv.slice(at + 1)
  if (flags.indexOf('--name') < 0 || !name || !command) {
    process.stderr.write('usage: mcp-timer.cjs --name <server> -- <command> [args…]\n')
    process.exit(2)
  }
  const log = (entry) => {
    try {
      appendFileSync(
        join(__dirname, '..', 'mcp-startup.jsonl'),
        `${JSON.stringify({ server: name, ...entry })}\n`,
      )
    } catch {}
  }
  const spawnedAt = Date.now()
  let settled = false
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    log({ spawnedAt, timeout: true })
    process.stderr.write(
      `reeval: MCP server ${name} didn't answer initialize within ${TIMEOUT_MS / 1000}s\n`,
    )
    child.kill('SIGKILL')
    process.exit(1)
  }, TIMEOUT_MS)
  const watch = handshake(() => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    log({ spawnedAt, initializedAt: Date.now() })
  })
  child.on('error', (error) => {
    process.stderr.write(`reeval: couldn't start MCP server ${name}: ${error.message}\n`)
  })
  child.stdin.on('error', () => {})
  process.stdin.on('data', (chunk) => {
    child.stdin.write(chunk)
    watch.fromClient(chunk)
  })
  process.stdin.on('end', () => child.stdin.end())
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    watch.fromServer(chunk)
  })
  process.stdout.on('error', () => child.kill())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    if (!settled) {
      settled = true
      log({ spawnedAt, exitCode: code })
    }
    const status = code ?? (signal ? 128 + (require('node:os').constants.signals[signal] ?? 1) : 1)
    process.stdout.write('', () => process.exit(status))
  })
}

if (require.main === module) main(process.argv.slice(2))
else module.exports = { scanner, handshake }
