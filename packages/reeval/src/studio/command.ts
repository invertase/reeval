import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { cloudUrl } from '../cloud-run.ts'
import { UsageError } from '../errors.ts'
import { scratchDir } from '../history/files.ts'
import { fromCwd } from '../ids.ts'
import type { ResolvedConfig } from '../types.ts'
import { RUN_ID } from '../view/api.ts'
import { openBrowser, startStudio } from './index.ts'
import { listHeaders, type StudioSource } from './source.ts'

export type StudioFlags = {
  port?: string
  'no-open'?: boolean
  'no-scratch'?: boolean
}

type Args = {
  config: ResolvedConfig
  flags: StudioFlags
  version: string
  run: string | undefined
  /** How long to wait for the hosted page to pair before printing the summary's path. */
  handshakeMs?: number
}

/** The run's summary.md, from the history folder or `.reeval/runs`; null when neither has one. */
function summaryPath(source: StudioSource, runId: string): string | null {
  for (const dir of [source.historyDir, scratchDir(source.root)]) {
    const file = join(dir, runId, 'summary.md')
    if (existsSync(file)) return file
  }
  return null
}

/** What `reeval studio` prints when the hosted page hasn't paired in time: why, and what to open instead. */
export function handshakeTimeoutLines(server: string, report: string | null): string[] {
  return [
    `The studio page hasn't connected yet: your browser may block it from reaching ${server}.`,
    '  Chrome asks first whether the page may reach apps on your device: choose Allow.',
    "  Safari can't reach a local server from a secure page: open the address in Chrome.",
    ...(report ? [`The run's Markdown report is at ${report}`] : []),
  ]
}

export async function studioCommand({ config, flags, version, run, handshakeMs = 8000 }: Args) {
  const port = flags.port === undefined ? 4984 : Number(flags.port)
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new UsageError(`--port must be a port number (got ${flags.port})`)
  }
  if (run !== undefined && !RUN_ID.test(run)) throw new UsageError(`${run} isn't a run id`)
  const source: StudioSource = {
    root: config.root,
    historyDir: config.history.dir,
    scratch: !flags['no-scratch'],
  }
  const focus = run ?? (await listHeaders(source)).at(-1)?.runId ?? null
  let paired = false
  const studio = await startStudio({
    source,
    port,
    reeval: version,
    project: basename(config.root),
    studioUrl: new URL('studio', cloudUrl()),
    focus,
    onPair: () => {
      paired = true
      console.log('Paired with the studio page.')
    },
  })
  console.log(`reeval studio · ${basename(config.root)} · serving ${studio.server} (loopback only)`)
  console.log(`  ${studio.url}`)
  console.log('Ctrl-C to stop.')
  if (!flags['no-open']) openBrowser(studio.url)
  const waiting = setTimeout(() => {
    if (paired) return
    const summary = focus ? summaryPath(source, focus) : null
    const report = summary ? fromCwd(summary) || summary : null
    for (const line of handshakeTimeoutLines(studio.server, report)) console.log(line)
  }, handshakeMs)
  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', resolveStop)
    process.once('SIGTERM', resolveStop)
  })
  clearTimeout(waiting)
  studio.close()
  return 0
}
