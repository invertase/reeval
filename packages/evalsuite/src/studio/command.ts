import { basename, join, resolve } from 'node:path'
import { UsageError } from '../errors.ts'
import { relativeFile } from '../ids.ts'
import type { ResolvedConfig } from '../types.ts'
import { APP_DIR, buildStudio, openBrowser, startStudio } from './index.ts'

export type StudioFlags = {
  port?: string
  host?: string
  open?: boolean
  out?: string
  scratch?: boolean
  'no-scratch'?: boolean
  'no-token'?: boolean
  'no-artifacts'?: boolean
}

type Args = { config: ResolvedConfig; flags: StudioFlags; version: string; build: boolean }

const kb = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`

export async function studioCommand({ config, flags, version, build }: Args): Promise<number> {
  const project = basename(config.root)
  const rel = (path: string) => relativeFile(process.cwd(), path) || '.'
  if (build) {
    const out = flags.out ? resolve(flags.out) : join(config.root, 'studio-dist')
    const artifacts = !flags['no-artifacts']
    const result = await buildStudio({
      source: { root: config.root, historyDir: config.history.dir, scratch: !!flags.scratch },
      appDir: APP_DIR,
      out,
      artifacts,
      es: version,
      project,
    })
    console.log(
      `built ${rel(out)}/: ${result.runs} run${result.runs === 1 ? '' : 's'}, ${result.files} files, ${kb(result.bytes)}${artifacts ? ' (records, transcripts, diffs, logs and judge inputs)' : ' (records only: --no-artifacts)'}`,
    )
    console.log(
      'Serve it from any static host. Anyone who can open it can read every included file.',
    )
    return 0
  }
  const port = flags.port === undefined ? 4984 : Number(flags.port)
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new UsageError(`--port must be a port number (got ${flags.port})`)
  }
  const host = flags.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.error(`warning: studio is listening on ${host}, reachable beyond this machine`)
  }
  const token = !flags['no-token']
  if (!token) console.error('warning: --no-token lets any local process or user read the studio')
  const studio = await startStudio({
    source: { root: config.root, historyDir: config.history.dir, scratch: !flags['no-scratch'] },
    host,
    port,
    token,
    es: version,
    project,
  })
  console.log(`es studio · ${project} · ${rel(config.history.dir)}/`)
  console.log(`  ${studio.url}`)
  console.log('Ctrl-C to stop.')
  if (flags.open) openBrowser(studio.url)
  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', resolveStop)
    process.once('SIGTERM', resolveStop)
  })
  studio.close()
  return 0
}
