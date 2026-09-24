import type { Socket } from 'node:net'
import type { Limits, Rank } from './core.ts'

export type SchedulerAddress = { port: number; token: string }

export type ClientMessage =
  | { t: 'hello'; token: string }
  | { t: 'request'; id: string; limits: Limits; rank?: Rank }
  | { t: 'release'; id: string }

export type ServerMessage = { t: 'grant'; id: string }

/** Newline-delimited JSON. */
export function lines<T>(socket: Socket, onMessage: (message: T) => void): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line) as T)
      } catch {}
    }
  })
}
