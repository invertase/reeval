#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { appendFile, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { detectAgent } from 'std-env'
import {
  hostCapacity,
  loadConfig,
  missingCredentials,
  resolveConcurrency,
  UsageError,
} from './config.ts'
import { inCI, loadEnvFiles } from './env.ts'
import { author, gitInfo, runnerInfo } from './history/provenance.ts'
import { evalSlug, newRunId } from './ids.ts'
import { harnessId, sandboxId } from './options.ts'
import { preflight } from './preflight.ts'
import { colors } from './ui/colors.ts'
import { createRenderer, resolveOutput } from './ui/index.ts'

const HISTORY_COMMANDS = { record: 1, history: 1, show: 1, compare: 1, checkout: 1 }

const EXPECTED_ERRORS = ['CommandError', 'RefError', 'HistoryError', 'StudioBuildError']

const EXIT = { ok: 0, failed: 1, usage: 2, infra: 3, interrupted: 130 } as const

const version: string = createRequire(import.meta.url)('../package.json').version

const HELP = `es ${version} — eval runner for coding agents

Usage:
  es run [filter...]        Run evals matching config.include; filters are path, name or cell substrings
    --runs <n>              Attempts per cell, overriding the config, groups and evals
    --concurrency <n>       Attempts running at once across evals and cells (default 8, at
                            most one per CPU and GB of Docker memory; also ES_CONCURRENCY)
    --tag <tag>             Only evals with this tag; !tag excludes it; repeat to combine (AND)
    --record                Also record the run into the history folder (see config.record)
    --ui <mode>             live, plain or agent (default: agent under a coding agent, plain
                            in CI or when piped, else live; live prints plain for now)
    --log-order <order>     stream (every line as it happens) or grouped (each attempt as one
                            block when it ends); default grouped in CI, else stream
    --log-prefix <prefix>   task or none: the [eval#n harness] prefix on detail lines
                            (default task, none inside GitHub Actions groups)
    --output-logs <level>   full, errors-only or none: whose detail lines print (default full)
  es record [run...]        Copy runs (default: latest) from .es/runs into the history folder
                            --artifacts all|failures|none --allow-incomplete --skip-secret-scan
  es history [filter]       Pass/fail per recorded eval over recent runs
                            --limit <n> --all (include unrecorded runs) --json
  es show [run]             One run: table, --md (summary.md) or --json (the record)
  es compare [base] [head]  Diff two runs; base defaults to head's nearest recorded ancestor
                            --md --json --fail-on-regression
  es checkout [run] [dir]   A git worktree at the run's commit, with its worktree.patch applied
                            (default dir: .es/checkouts/<run>)
  es studio                 Browse runs, evals and transcripts in the web studio (127.0.0.1)
    --port <n>              First port to try (default 4984); --host <addr> (default 127.0.0.1)
    --open                  Open the browser; --no-scratch hides unrecorded runs from .es/runs
    --no-token              Skip the session token (for scripts; anyone local can then read it)
  es studio build           Write the studio as a static site for Pages, Netlify or any host
    --out <dir>             Output folder (default studio-dist); --scratch adds unrecorded runs
    --no-artifacts          Records and index only: no transcripts, diffs, logs or judge inputs
  es image build            Build the Docker sandbox image (bakes in the Cursor CLI)
  es --version
  es --help

Runs are latest, latest~N, a run id (or unique prefix), or a git SHA prefix.
Options: --config <path> (default ./es.config.ts)
Exit codes: 0 passed, 1 failed, 2 usage/config error, 3 infra error, 130 interrupted
`

const { green, red, dim } = colors(!!process.stdout.isTTY && !process.env.NO_COLOR)

/** Set by the first Ctrl-C of `es run`. */
let interrupted = false

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
      runs: { type: 'string' },
      concurrency: { type: 'string' },
      ui: { type: 'string' },
      'log-order': { type: 'string' },
      'log-prefix': { type: 'string' },
      'output-logs': { type: 'string' },
      tag: { type: 'string', multiple: true },
      port: { type: 'string' },
      host: { type: 'string' },
      open: { type: 'boolean' },
      out: { type: 'string' },
      scratch: { type: 'boolean' },
      'no-scratch': { type: 'boolean' },
      'no-token': { type: 'boolean' },
      'no-artifacts': { type: 'boolean' },
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
  if (command === 'studio') {
    const config = await loadConfig(values.config, 'studio')
    const { studioCommand } = await import('./studio/command.ts')
    return studioCommand({ config, flags: values, version, build: filters[0] === 'build' })
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

  const output = resolveOutput({
    flags: {
      ui: values.ui,
      logOrder: values['log-order'],
      logPrefix: values['log-prefix'],
      outputLogs: values['output-logs'],
    },
    env: process.env,
    isTTY: !!process.stdout.isTTY,
    agent: detectAgent().name,
  })
  loadEnvFiles(process.cwd())
  const config = await loadConfig(values.config)
  const missing = missingCredentials(config)
  if (missing.length) {
    throw new UsageError(
      `Missing credentials: ${missing.join(', ')}. Set them in the environment or .env.local.`,
    )
  }
  const sandboxVersions = await preflight(config)
  let runs: number | undefined
  if (values.runs !== undefined) {
    runs = Number(values.runs)
    if (!(Number.isInteger(runs) && runs >= 1)) {
      throw new UsageError(`--runs must be a whole number of at least 1 (got ${values.runs})`)
    }
  }
  const tags = values.tag ?? []
  const concurrency = await resolveConcurrency(config, values.concurrency, async () => {
    if (!config.sandbox.some((s) => s.kind === 'docker')) return hostCapacity()
    const { dockerCapacity } = await import('./sandbox/docker-cli.ts')
    return (await dockerCapacity()) ?? hostCapacity()
  })
  if (
    config.harness.some((h) => h.kind === 'cursor') &&
    config.sandbox.some((s) => s.kind === 'docker')
  ) {
    console.error(
      colors(output.color).yellow(
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
  // Run ids sort in run order, so a second run in the same second takes the next second's id.
  let runId = newRunId(startedAt, git?.sha ?? null, who)
  for (let n = 1; existsSync(join(scratchDir(config.root), `${runId}.json`)); n++) {
    runId = newRunId(new Date(startedAt.getTime() + n * 1000), git?.sha ?? null, who)
  }
  await sweepStaging(config.root)
  // Workers create it with their first record; a run that never starts leaves nothing behind.
  const resultsDir = stagingDir(config.root, runId)
  const ctx = { runId, resultsDir, config, runs, tags, concurrency }

  const { engineVersions, runEngine } = await import('./engine/node.ts')

  const renderer = createRenderer({
    out: process.stdout,
    output,
    harness: config.harness[0]?.kind ?? 'agent',
    attemptDir: (id, cell, n) =>
      relative(
        process.cwd(),
        join(scratchDir(config.root), runId, evalSlug(id), evalSlug(cell), String(n)),
      ),
  })
  let engineRun: Awaited<ReturnType<typeof runEngine>>
  try {
    engineRun = await runEngine({
      run: ctx,
      filters,
      onRunStart: (files) =>
        renderer.onEvent({
          type: 'run-start',
          at: Date.now(),
          version,
          files,
          harness: config.harness.map(harnessId).join(', '),
          sandbox: config.sandbox.map(sandboxId).join(', '),
          concurrency,
        }),
      onEvent: (e) => {
        // Attempts cut short by Ctrl-C are reported from the merged record, in the summary.
        if (interrupted && e.type === 'eval-end' && e.result.state === 'skipped') return
        renderer.onEvent(e)
      },
      onCancellable: (cancel) => {
        process.on('SIGINT', () => {
          if (interrupted) {
            renderer.close()
            process.exit(EXIT.interrupted)
          }
          interrupted = true
          renderer.onEvent({
            type: 'notice',
            at: Date.now(),
            level: 'warn',
            text: 'Cancelling: stopping agents and destroying sandboxes (Ctrl-C again to force)',
          })
          cancel()
        })
      },
    })
  } catch (error) {
    renderer.close()
    await rm(resultsDir, { recursive: true, force: true })
    throw error
  }
  const narrowed = [
    filters.length ? `filter "${filters.join(' ')}"` : '',
    tags.length ? `tags ${tags.join(', ')}` : '',
  ].filter(Boolean)
  if (engineRun.noFiles || (engineRun.evals.length === 0 && !interrupted)) {
    renderer.close()
    await rm(resultsDir, { recursive: true, force: true })
    throw new UsageError(
      `No evals matched ${config.include.join(', ')}${narrowed.length ? ` with ${narrowed.join(' and ')}` : ''}`,
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
    enginePackages: engineVersions,
    sandbox: sandboxVersions,
    worktreePatch: patch,
    lockfiles: await lockfiles(config.root),
    git,
    runner: runnerInfo(),
  })
  const { record } = run
  const summary = run.artifactDir ? join(run.artifactDir, 'summary.md') : run.recordPath
  renderer.onEvent({
    type: 'run-end',
    at: Date.now(),
    record,
    summaryPath: relative(process.cwd(), summary),
    results: engineRun.evals,
    unhandledErrors: engineRun.unhandledErrors,
  })
  renderer.close()
  const stepSummary = process.env.GITHUB_STEP_SUMMARY
  if (stepSummary && run.artifactDir) {
    await appendFile(stepSummary, await readFile(summary)).catch(() => {})
  }

  const autoRecord =
    values.record || config.record === 'always' || (config.record === 'ci' && inCI())
  if (autoRecord && record.status === 'complete') {
    const { record: recordCmd } = await import('./commands.ts')
    console.log(await recordCmd(config, record.runId, values))
  }

  if (interrupted || engineRun.cancelled) return EXIT.interrupted
  if (record.summary.fail > 0 || engineRun.unhandledErrors.length > 0) return EXIT.failed
  if (record.summary.infraError > 0) return EXIT.infra
  return EXIT.ok
}

// `es run | head` closes stdout early; that isn't an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

let settled = false
// A Ctrl-C to the whole process group can kill a Vitest worker while Node is still booting it,
// before it can ignore SIGINT. Vitest then never settles and the event loop simply drains.
process.on('beforeExit', () => {
  if (settled) return
  console.error(red('es: interrupted before the evals could start; nothing was recorded'))
  process.exit(interrupted ? EXIT.interrupted : EXIT.infra)
})

run(process.argv.slice(2)).then(
  (code) => {
    settled = true
    process.exitCode = code
  },
  (error: unknown) => {
    const name = (error as Error).name
    const expected =
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ||
      EXPECTED_ERRORS.includes(name)
    settled = true
    console.error(red(`es: ${(error as Error).message}`))
    if (!expected && process.env.ES_DEBUG) console.error(error)
    process.exitCode = EXIT.usage
  },
)
