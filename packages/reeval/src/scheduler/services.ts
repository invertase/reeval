// Worker side of the run's services: in an eval file's worker, calls go over its IPC channel to
// the main process (useServiceChannel), which holds what every worker shares, such as the machine
// pools; anywhere else, to the in-process host the caller names.

/** What a worker sends the run's services (reeval's engine, over the worker's IPC channel). */
export type CallMessage = { t: 'call'; id: string; service: string; body: unknown }
export type ReplyMessage = { t: 'reply'; id: string; body?: unknown; error?: string }

/** A service in this process: what answers calls when there's no channel to the main process. */
export type LocalService = (body: unknown) => Promise<unknown>

type Pending = { resolve: (body: unknown) => void; reject: (error: Error) => void }

let send: ((message: CallMessage) => void) | undefined
const pending = new Map<string, Pending>()
let ids = 0

/** Points this process's calls at the main process over `send`; returns what delivers replies. */
export function useServiceChannel(
  sendMessage: (message: CallMessage) => void,
): (reply: ReplyMessage) => void {
  send = sendMessage
  return (reply) => {
    const call = pending.get(reply.id)
    if (!call) return
    pending.delete(reply.id)
    if (reply.error !== undefined) call.reject(new Error(reply.error))
    else call.resolve(reply.body)
  }
}

/** Whether calls go to the main process: this is an eval file's worker. */
export const hasServiceChannel = () => send !== undefined

/**
 * Calls `service` with `body`: over the channel in a worker, else `local`. Rejects with the
 * service's error message.
 */
export function callService(service: string, body: unknown, local: LocalService): Promise<unknown> {
  if (!send) return local(body)
  const id = String(++ids)
  const out = send
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    out({ t: 'call', id, service, body })
  })
}
