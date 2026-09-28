import type { Duplex } from 'node:stream'

export type MuxStream = Duplex

export type Mux = {
  /** Feed bytes read from the peer. */
  receive(chunk: Buffer): void
  /** Opens a stream to `port` on the peer's side. */
  open(port: number): MuxStream
  /** Tells the peer this side is ready to accept streams. */
  ready(): void
  destroy(): void
}

export type MuxOptions = {
  Duplex: typeof Duplex
  send(frame: Buffer): void
  /** Stream ids this side allocates: 0 for even, 1 for odd, so both sides can open streams. */
  parity: 0 | 1
  onOpen(stream: MuxStream, port: number): void
  onReady?(): void
  /** Bytes a stream may have in flight before the receiver grants more. */
  window?: number
}

/**
 * Many TCP streams over one byte pipe (a `docker exec` stdio), with per-stream credit so a slow
 * reader only stalls its own stream. Frames are `type u8, id u32, length u32, payload`.
 *
 * Must stay self-contained, with no imports or references to module scope: the forwarder runs
 * this function's source inside the container.
 */
export function createMux(options: MuxOptions): Mux {
  const OPEN = 1
  const DATA = 2
  const FIN = 3
  const RST = 4
  const WINDOW = 5
  const READY = 6
  const windowSize = options.window ?? 256 * 1024
  const maxPayload = 64 * 1024
  type State = {
    stream: Duplex
    credit: number
    unacked: number
    blocked: (() => void) | null
    localEnded: boolean
    remoteEnded: boolean
    reset: boolean
  }
  const streams = new Map<number, State>()
  let nextId = options.parity === 0 ? 2 : 1
  let pending: Buffer = Buffer.alloc(0)

  const frame = (type: number, id: number, payload: Buffer = Buffer.alloc(0)) => {
    const header = Buffer.alloc(9)
    header.writeUInt8(type, 0)
    header.writeUInt32BE(id, 1)
    header.writeUInt32BE(payload.length, 5)
    options.send(Buffer.concat([header, payload]))
  }
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }

  const create = (id: number): Duplex => {
    const grant = () => {
      if (state.unacked > 0 && !state.reset) frame(WINDOW, id, u32(state.unacked))
      state.unacked = 0
    }
    const stream = new options.Duplex({
      allowHalfOpen: true,
      read() {
        grant()
      },
      write(chunk: Buffer, _encoding, callback) {
        for (let i = 0; i < chunk.length; i += maxPayload) {
          frame(DATA, id, chunk.subarray(i, i + maxPayload))
        }
        state.credit -= chunk.length
        if (state.credit > 0) callback()
        else state.blocked = callback
      },
      final(callback) {
        state.localEnded = true
        frame(FIN, id)
        callback()
      },
      destroy(error, callback) {
        streams.delete(id)
        if (!state.reset && !(state.localEnded && state.remoteEnded)) frame(RST, id)
        state.blocked = null
        callback(error)
      },
    })
    const state: State = {
      stream,
      credit: windowSize,
      unacked: 0,
      blocked: null,
      localEnded: false,
      remoteEnded: false,
      reset: false,
    }
    streams.set(id, state)
    return stream
  }

  const handle = (type: number, id: number, payload: Buffer) => {
    if (type === READY) return options.onReady?.()
    if (type === OPEN) return options.onOpen(create(id), payload.readUInt16BE(0))
    const state = streams.get(id)
    if (!state) return
    if (type === DATA) {
      state.unacked += payload.length
      if (state.stream.push(payload) && state.unacked >= windowSize / 2) {
        frame(WINDOW, id, u32(state.unacked))
        state.unacked = 0
      }
    } else if (type === WINDOW) {
      state.credit += payload.readUInt32BE(0)
      const blocked = state.blocked
      if (state.credit > 0 && blocked) {
        state.blocked = null
        blocked()
      }
    } else if (type === FIN) {
      state.remoteEnded = true
      state.stream.push(null)
    } else if (type === RST) {
      state.reset = true
      state.stream.destroy()
    }
  }

  return {
    receive(chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length >= 9) {
        const length = pending.readUInt32BE(5)
        if (pending.length < 9 + length) break
        const type = pending.readUInt8(0)
        const id = pending.readUInt32BE(1)
        const payload = pending.subarray(9, 9 + length)
        pending = pending.subarray(9 + length)
        handle(type, id, payload)
      }
    },
    open(port) {
      const id = nextId
      nextId += 2
      const stream = create(id)
      const p = Buffer.alloc(2)
      p.writeUInt16BE(port, 0)
      frame(OPEN, id, p)
      return stream
    },
    ready() {
      frame(READY, 0)
    },
    destroy() {
      for (const state of [...streams.values()]) state.stream.destroy()
    },
  }
}

/**
 * Pipes two duplexes into each other. An error, or one side closing before its end, tears both
 * down; a clean end half-closes the other side through `pipe`.
 */
export function link(a: Duplex, b: Duplex): void {
  a.pipe(b)
  b.pipe(a)
  const kill = () => {
    a.destroy()
    b.destroy()
  }
  for (const s of [a, b]) {
    s.on('error', kill)
    s.on('close', () => {
      if (!s.readableEnded) kill()
    })
  }
}

export type ForwarderIO = {
  net: typeof import('node:net')
  Duplex: typeof Duplex
  input: NodeJS.ReadableStream
  output: { write(chunk: Buffer): unknown }
  error(message: string): void
  exit(code: number): void
}

/**
 * The container side: listens on 127.0.0.1:`proxyPort` and sends each connection to the host,
 * and connects the host's streams to 127.0.0.1:<port> (the harness bridge). Self-contained for
 * the same reason as {@link createMux}.
 */
export function forwarderMain(
  io: ForwarderIO,
  makeMux: typeof createMux,
  linkStreams: typeof link,
  proxyPort: number,
): void {
  const mux = makeMux({
    Duplex: io.Duplex,
    parity: 1,
    send: (f) => io.output.write(f),
    onOpen(stream, port) {
      linkStreams(io.net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }), stream)
    },
  })
  io.input.on('data', (chunk: Buffer) => mux.receive(chunk))
  io.input.on('end', () => io.exit(0))
  const server = io.net.createServer({ allowHalfOpen: true }, (socket) =>
    linkStreams(socket, mux.open(proxyPort)),
  )
  server.on('error', (error) => {
    io.error(`reeval egress forwarder: ${error.message}`)
    io.exit(1)
  })
  server.listen(proxyPort, '127.0.0.1', () => mux.ready())
}

/** The `node -e` script that runs {@link forwarderMain} in the container. */
export const forwarderScript = (proxyPort: number) =>
  `(${forwarderMain.toString()})({ net: require('node:net'), Duplex: require('node:stream').Duplex, input: process.stdin, output: process.stdout, error: (m) => process.stderr.write(m + '\\n'), exit: (c) => process.exit(c) }, ${createMux.toString()}, ${link.toString()}, ${proxyPort})`
