#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig, missingCredentials, UsageError } from './config.ts'
import type { EngineEval } from './engine/node.ts'
import { loadEnvFiles } from './env.ts'
import { author, gitInfo, runnerInfo } from './history/provenance.ts'
import type { RunSummary } from './history/types.ts'
import { newRunId } from './ids.ts'
import { preflight } from './preflight.ts'

const HISTORY_COMMANDS = { record: 1, history: 1, show: 1, compare: 1, checkout: 1 }

const EXPECTED_ERRORS = ['CommandError', 'RefError', 'HistoryError']

const EXIT = { ok: 0, failed: 1, usage: 2, infra: 3, interrupted: 130 } as const

const version: string = createRequire(import.meta.url)('../package.json').version

const HELP = `es ${version} — eval runner for coding agents

Usage:
  es run [filter...]        Run evals matching config.include; filters are path or name substrings
    --record                Also record the run into the history folder (see config.record)
  es record [run...]        Copy runs (default: latest) from .es/runs into the history folder
                            --artifacts all|failures|none --allow-incomplete --skip-secret-scan
  es history [filter]       Pass/fail per recorded eval over recent runs
                            --limit <n> --all (include unrecorded runs) --json
  es show [run]             One run: table, --md (summary.md) or --json (the record)
  es compare [base] [head]  Diff two runs; base defaults to head's nearest recorded ancestor
                            --md --json --fail-on-regression
  es checkout [run] [dir]   A git worktree at the run's commit, with its worktree.patch applied
                            (default dir: .es/checkouts/<run>)
  es image build            Build the Docker sandbox image (bakes in the Cursor CLI)
  es --version
  es --help

Runs are latest, latest~N, a run id (or unique prefix), or a git SHA prefix.
Options: --config <path> (default ./es.config.ts)
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
  for (const j of e.meta?.judgements ?? []) {
    const mark = j.verdict === 'pass' ? green(j.verdict) : red(j.verdict)
    console.log(
      `     ${dim('judge')}  ${mark} ${j.score.toFixed(2)} ${dim(`(≥ ${j.threshold})`)}  ${j.question}`,
    )
  }
  if (outcome === 'infra_error') console.log(`     ${yellow('infra error')}  ${e.errors[0] ?? ''}`)
  else if (e.state === 'failed') {
    for (const line of (e.errors[0] ?? '').split('\n').slice(0, 12))
      console.log(`     ${red(line)}`)
  }
}

function summaryLine(s: RunSummary, resultPath: string) {
  const parts = [
    s.pass && green(`${s.pass} passed`),
    s.fail && red(`${s.fail} failed`),
    s.infraError && yellow(`${s.infraError} infra error`),
    s.skipped && dim(`${s.skipped} skipped`),
  ].filter(Boolean)
  return `${parts.join(' · ') || 'no evals ran'} · run ${resultPath}`
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'es.config.ts' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      md: { type: 'boolean' },
      all: { type: 'boolean' },
      record: { type: 'boolean' },
      artifacts: { type: 'string' },
      'allow-incomplete': { type: 'boolean' },
      'skip-secret-scan': { type: 'boolean' },
      limit: { type: 'string' },
      'fail-on-regression': { type: 'boolean' },
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
  if (command in HISTORY_COMMANDS) {
    const config = await loadConfig(values.config, command)
    const commands = await import('./commands.ts')
    const ctx = { config, flags: values, out: (s: string) => console.log(s) }
    switch (command as keyof typeof HISTORY_COMMANDS) {
      case 'record':
        return commands.recordCommand(ctx, filters)
      case 'history':
        return commands.historyCommand(ctx, filters)
      case 'show':
        return commands.showCommand(ctx, filters)
      case 'compare':
        return commands.compareCommand(ctx, filters)
      case 'checkout':
        return commands.checkoutCommand(ctx, filters)
    }
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

  const startedAt = new Date()
  const git = await gitInfo(config.root, [config.history.dir])
  const { lockfiles, worktreePatch } = await import('./history/state.ts')
  const patch = git?.dirty ? await worktreePatch(config.root, [config.history.dir]) : null
  const who = await author(config.root)
  const { stagingDir, sweepStaging, writeScratchRun } = await import('./results.ts')
  const { scratchDir } = await import('./history/files.ts')
  let runId = newRunId(startedAt, git?.sha ?? null, who)
  for (let n = 2; existsSync(join(scratchDir(config.root), `${runId}.json`)); n++) {
    runId = newRunId(startedAt, git?.sha ?? null, `${who}-${n}`)
  }
  await sweepStaging(config.root)
  const resultsDir = stagingDir(config.root, runId)
  await mkdir(resultsDir, { recursive: true })
  const ctx = { runId, resultsDir, config }

  const { runEngine } = await import('./engine/node.ts')

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

  const run = await writeScratchRun({
    ctx,
    author: who,
    engine: engineRun,
    startedAt,
    endedAt: new Date(),
    interrupted: interrupted || engineRun.cancelled,
    es: version,
    sandbox: sandboxVersions,
    worktreePatch: patch,
    lockfiles: await lockfiles(config.root),
    git,
    runner: runnerInfo(),
  })
  const { record } = run
  if (interrupted) {
    for (const e of record.evals.filter((e) => e.attempts[0]?.error?.kind === 'aborted')) {
      console.log(` ${red('✗')} ${e.id}   ${dim('cancelled')}`)
    }
  }
  for (const error of engineRun.unhandledErrors) console.error(red(`error: ${error}`))
  const summary = run.artifactDir ? join(run.artifactDir, 'summary.md') : run.recordPath
  console.log(summaryLine(record.summary, relative(process.cwd(), summary)))

  const ci = !!process.env.CI && process.env.CI !== 'false'
  const autoRecord = values.record || config.record === 'always' || (config.record === 'ci' && ci)
  if (autoRecord && record.status === 'complete') {
    const { record: recordCmd } = await import('./commands.ts')
    console.log(await recordCmd(config, record.runId, values))
  }

  if (interrupted || engineRun.cancelled) return EXIT.interrupted
  if (record.summary.fail > 0 || engineRun.unhandledErrors.length > 0) return EXIT.failed
  if (record.summary.infraError > 0) return EXIT.infra
  return EXIT.ok
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    const name = (error as Error).name
    const expected =
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ||
      EXPECTED_ERRORS.includes(name)
    console.error(red(`es: ${(error as Error).message}`))
    if (!expected && process.env.ES_DEBUG) console.error(error)
    process.exitCode = EXIT.usage
  },
)
