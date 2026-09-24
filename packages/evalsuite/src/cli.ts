#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig, missingCredentials, UsageError } from './config.ts'
import type { EngineEval } from './engine/node.ts'
import { loadEnvFiles } from './env.ts'
import { newRunId } from './ids.ts'
import { preflight } from './preflight.ts'
import type { EsResult } from './types.ts'

const EXIT = { ok: 0, failed: 1, usage: 2, infra: 3, interrupted: 130 } as const

const version: string = createRequire(import.meta.url)('../package.json').version

const HELP = `es ${version} — eval runner for coding agents

Usage:
  es run [filter...]      Run evals matching config.include; filters are path or name substrings
    --config <path>       Config file (default ./es.config.ts)
  es image build          Build the Docker sandbox image (bakes in the Cursor CLI)
  es --version
  es --help

Exit codes: 0 passed, 1 failed, 2 usage/config error, 3 infra error, 130 interrupted
`

const color = (code: number) => (s: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s
const green = color(32)
const red = color(31)
const yellow = color(33)
const dim = color(2)

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function printEval(e: EngineEval) {
  const outcome =
    e.state === 'skipped'
      ? 'skipped'
      : (e.meta?.outcome ?? (e.state === 'passed' ? 'pass' : 'fail'))
  const mark = { pass: green('✓'), fail: red('✗'), infra_error: yellow('!'), skipped: dim('↓') }[
    outcome
  ]
  const time = e.state === 'skipped' ? '' : `   ${dim(formatDuration(e.durationMs))}`
  console.log(` ${mark} ${e.id}${time}`)
  if (e.meta?.verdict)
    console.log(`     ${dim('judge')}  ${e.meta.verdict.verdict}: "${e.meta.verdict.reason}"`)
  if (outcome === 'infra_error') console.log(`     ${yellow('infra error')}  ${e.errors[0] ?? ''}`)
  else if (e.state === 'failed') {
    for (const line of (e.errors[0] ?? '').split('\n').slice(0, 12))
      console.log(`     ${red(line)}`)
  }
}

function summaryLine(s: EsResult['summary'], resultPath: string) {
  const parts = [
    s.passed && green(`${s.passed} passed`),
    s.failed && red(`${s.failed} failed`),
    s.infraError && yellow(`${s.infraError} infra error`),
    s.skipped && dim(`${s.skipped} skipped`),
  ].filter(Boolean)
  return `${parts.join(' · ') || 'no evals ran'} · results ${resultPath}`
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'es.config.ts' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  if (values.version) {
    console.log(version)
    return EXIT.ok
  }
  const [command, ...filters] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return values.help ? EXIT.ok : EXIT.usage
  }
  if (command === 'image' && filters[0] === 'build') {
    const { buildImage } = await import('./sandbox/build-image.ts')
    const { image } = await buildImage((line) => console.log(dim(line)))
    console.log(green(`Built ${image}`))
    return EXIT.ok
  }
  if (command !== 'run') throw new UsageError(`Unknown command "${command}". Run es --help.`)

  loadEnvFiles(process.cwd())
  const config = await loadConfig(values.config)
  const missing = missingCredentials(config)
  if (missing.length) {
    throw new UsageError(
      `Missing credentials: ${missing.join(', ')}. Set them in the environment or .env.local.`,
    )
  }
  const sandboxVersions = await preflight(config)
  if (config.harness.kind === 'cursor' && config.sandbox.kind === 'docker') {
    console.error(
      yellow(
        'warning: CURSOR_API_KEY is passed into the sandbox container, where the agent can read it',
      ),
    )
  }

  const runId = newRunId()
  const resultsDir = join(config.root, '.es', 'results', runId)
  await mkdir(resultsDir, { recursive: true })
  const ctx = { runId, resultsDir, config }
  const startedAt = new Date()

  const { runEngine, vitestVersion } = await import('./engine/node.ts')
  const { writeResult } = await import('./results.ts')

  let interrupted = false
  const engineRun = await runEngine({
    run: ctx,
    filters,
    // Evals cut short by Ctrl-C are printed once their records are merged, below.
    onEvalResult: (e) => {
      if (!interrupted || e.state !== 'skipped') printEval(e)
    },
    onCancellable: (cancel) => {
      process.on('SIGINT', () => {
        if (interrupted) process.exit(EXIT.interrupted)
        interrupted = true
        console.log(
          yellow('\nCancelling: stopping agents and destroying sandboxes (Ctrl-C again to force)'),
        )
        cancel()
      })
    },
  })
  if (engineRun.noFiles) {
    throw new UsageError(
      `No evals matched ${config.include.join(', ')}${filters.length ? ` with filter "${filters.join(' ')}"` : ''}`,
    )
  }

  const { result, path } = await writeResult(ctx, engineRun, {
    startedAt,
    versions: { es: version, vitest: vitestVersion, ...sandboxVersions },
  })
  if (interrupted) {
    for (const e of result.evals.filter((e) => e.error?.kind === 'aborted')) {
      console.log(` ${red('✗')} ${e.id}   ${dim('cancelled')}`)
    }
  }
  for (const error of engineRun.unhandledErrors) console.error(red(`error: ${error}`))
  console.log(summaryLine(result.summary, relative(process.cwd(), path)))

  if (interrupted || engineRun.cancelled) return EXIT.interrupted
  if (result.summary.failed > 0 || engineRun.unhandledErrors.length > 0) return EXIT.failed
  if (result.summary.infraError > 0) return EXIT.infra
  return EXIT.ok
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    const usage =
      error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    console.error(red(`es: ${(error as Error).message}`))
    if (!usage && process.env.ES_DEBUG) console.error(error)
    process.exitCode = EXIT.usage
  },
)
