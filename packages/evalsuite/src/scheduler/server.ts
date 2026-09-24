// Main-process side of the scheduler: workers connect over a loopback socket and ask for
// leases. A worker's leases are released when its connection closes, however it exits.
import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { type Request, Scheduler } from './core.ts'
import { type ClientMessage, lines, type SchedulerAddress, type ServerMessage } from './protocol.ts'

/** How long the first grants wait for the other workers' attempts, so the start is fair. */
export const GATHER_MS = 3_000

export type SchedulerServer = {
  address: SchedulerAddress
  /** A file about to run collected this many attempts; the first grants wait for them. */
  expect(attempts: number): void
  close(): Promise<void>
}

/**
 * With `gatherFiles` above 1, nothing is granted until that many files have been collected and
 * all their attempts have asked (or {@link GATHER_MS} passes), so the first file's attempts
 * don't take every slot just because its worker started first.
 */
export async function startSchedulerServer(
  options: { gatherFiles?: number; gatherMs?: number } = {},
): Promise<SchedulerServer> {
  const token = randomBytes(16).toString('hex')
  const sockets = new Map<string, Socket>()
  const scheduler = new Scheduler((request) => {
    const at = request.id.indexOf(':')
    send(sockets.get(request.owner), { t: 'grant', id: request.id.slice(at + 1) })
  })

  const gatherFiles = options.gatherFiles ?? 0
  let files = 0
  let expected = 0
  let asked = 0
  let timer: NodeJS.Timeout | undefined
  let gathering = gatherFiles > 1
  const stopGathering = () => {
    if (!gathering) return
    gathering = false
    clearTimeout(timer)
    scheduler.resume()
  }
  const checkGathered = () => {
    if (files >= gatherFiles && asked >= expected) stopGathering()
  }
  if (gathering) scheduler.pause()

  let owners = 0
  const server: Server = createServer((socket) => {
    const owner = String(++owners)
    let authed = false
    socket.setNoDelay(true)
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(owner)
      scheduler.releaseOwner(owner)
    })
    lines(socket, (message: ClientMessage) => {
      if (!authed) {
        if (message.t !== 'hello' || message.token !== token) return socket.destroy()
        authed = true
        sockets.set(owner, socket)
        return
      }
      if (message.t === 'request') {
        const request: Request = { ...message, id: `${owner}:${message.id}`, owner }
        scheduler.request(request)
        if (request.rank && gathering) {
          asked++
          timer ??= setTimeout(stopGathering, options.gatherMs ?? GATHER_MS)
          checkGathered()
        }
      } else if (message.t === 'release') scheduler.release(`${owner}:${message.id}`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as { port: number }

  return {
    address: { port, token },
    expect(attempts) {
      if (!gathering) return
      files++
      expected += attempts
      checkGathered()
    },
    close: () =>
      new Promise((resolve) => {
        clearTimeout(timer)
        for (const socket of sockets.values()) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

function send(socket: Socket | undefined, message: ServerMessage) {
  if (socket && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
}
