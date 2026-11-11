import { spawn } from 'node:child_process'
import { serve } from '@hono/node-server'
import { allowedHosts, createStudioApi, newToken } from './server.ts'
import type { StudioSource } from './source.ts'

export type StartOptions = {
  source: StudioSource
  port: number
  reeval: string
  project: string
  /** The hosted studio page, such as `https://example.com/studio`. */
  studioUrl: URL
  focus: string | null
  onPair?: () => void
}

const HOST = '127.0.0.1'

type Listening = { close(): void }

function listen(app: ReturnType<typeof createStudioApi>, port: number) {
  return new Promise<Listening>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: HOST, port })
    server.once('error', reject)
    server.once('listening', () => resolve(server))
  })
}

/** The hosted page's URL for a data server: the server in `s`, the pairing token in the fragment. */
export function pairingUrl(studioUrl: URL, server: string, token: string, focus: string | null) {
  const url = new URL(studioUrl)
  url.searchParams.set('s', server)
  if (focus) url.searchParams.set('run', focus)
  url.hash = `t=${token}`
  return url.toString()
}

/**
 * Starts `reeval studio`'s data server on loopback, on the next free port from `port`, with a fresh
 * pairing token, and returns the hosted page's URL that pairs with it.
 */
export async function startStudio(options: StartOptions) {
  const token = newToken()
  for (let port = options.port; port < options.port + 20; port++) {
    const app = createStudioApi({
      source: options.source,
      reeval: options.reeval,
      project: options.project,
      origin: options.studioUrl.origin,
      pairingToken: token,
      hosts: allowedHosts(HOST, port),
      focus: options.focus,
      ...(options.onPair ? { onPair: options.onPair } : {}),
    })
    try {
      const server = await listen(app, port)
      const local = `http://localhost:${port}`
      return {
        url: pairingUrl(options.studioUrl, local, token, options.focus),
        server: local,
        port,
        close: () => server.close(),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(
    `Ports ${options.port}–${options.port + 19} are all in use: pass another with --port`,
  )
}

export function openBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawn(command, [url], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()
}
