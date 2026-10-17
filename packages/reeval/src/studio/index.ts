import { spawn } from 'node:child_process'
import { getRequestListener, serve } from '@hono/node-server'
import { scratchDir } from '../history/files.ts'
import { ownDir } from '../root.ts'
import { watchLive } from './live.ts'
import { allowedHosts, createStudioApp, newToken, type StudioEvent } from './server.ts'
import type { StudioSource } from './source.ts'
import { watchRuns } from './watch.ts'

export { buildStudio, StudioBuildError } from './build.ts'

/** Where the prebuilt web app ships inside the package (copied from packages/studio-web). */
export const APP_DIR = ownDir('dist/studio-app')

export type StartOptions = {
  source: StudioSource
  host: string
  port: number
  token: boolean
  reeval: string
  project: string
  appDir?: string
}

type Listening = { close(): void; address(): unknown }

function listen(app: ReturnType<typeof createStudioApp>, host: string, port: number) {
  return new Promise<Listening>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port })
    server.once('error', reject)
    server.once('listening', () => resolve(server))
  })
}

/** Starts `reeval studio`: the next free port from `port`, a fresh token, and a history watcher. */
export async function startStudio(options: StartOptions) {
  const { source, host } = options
  const token = options.token ? newToken() : null
  const listeners = new Set<(event: StudioEvent) => void>()
  const send = (event: StudioEvent) => {
    for (const l of listeners) l(event)
  }
  const stopRuns = watchRuns(
    source.scratch ? [source.historyDir, scratchDir(source.root)] : [source.historyDir],
    () => send({ type: 'history.changed' }),
  )
  const stopLive = watchLive(source, (runs) => send({ type: 'run.progress', runs }))
  const stopWatching = () => {
    stopRuns()
    stopLive()
  }
  for (let port = options.port; port < options.port + 20; port++) {
    const app = createStudioApp({
      source,
      appDir: options.appDir ?? APP_DIR,
      reeval: options.reeval,
      project: options.project,
      token,
      hosts: allowedHosts(host, port),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })
    try {
      const server = await listen(app, host, port)
      const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`
      return {
        url: token ? `${origin}/?token=${token}` : `${origin}/`,
        port,
        close() {
          stopWatching()
          server.close()
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        stopWatching()
        throw error
      }
    }
  }
  stopWatching()
  throw new Error(`Ports ${options.port}–${options.port + 19} are all in use; pass --port`)
}

export function openBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawn(command, [url], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()
}

/** The data routes as a Node request listener, for the studio-web dev server. No token or Host check. */
export function devListener(source: StudioSource, version: string) {
  const app = createStudioApp({
    source,
    appDir: APP_DIR,
    reeval: version,
    project: source.root.split(/[\\/]/).at(-1) ?? 'project',
    token: null,
    hosts: [],
  })
  return getRequestListener(app.fetch)
}
