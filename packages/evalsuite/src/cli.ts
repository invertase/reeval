#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { appendFile, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { detectAgent } from 'std-env'
import {
  hostCapacity,
  loadConfig,
  missingCredentials,
  parseDuration,
  resolveConcurrency,
  selectProfile,
  UsageError,
} from './config.ts'
import { budgetMarker } from './engine/cancel.ts'
import type { CollectedPlan, EngineRun, PlannedItem } from './engine/node.ts'
import { inCI, loadEnvFiles } from './env.ts'
import { author, gitInfo, runnerInfo } from './history/provenance.ts'
import type { GitInfo } from './history/types.ts'
import { evalSlug, newRunId, RUN_STAMP_LENGTH } from './ids.ts'
import { harnessId, sandboxId } from './options.ts'
import type { RunPlan } from './plan.ts'
import { preflight, type SandboxVersions } from './preflight.ts'
import type { RunContext, SandboxDescriptor } from './types.ts'
import { colors } from './ui/colors.ts'
import { createRenderer, resolveOutput } from './ui/index.ts'

const HISTORY_COMMANDS = { record: 1, history: 1, show: 1, compare: 1, checkout: 1 }

const EXPECTED_ERRORS = ['CommandError', 'RefError', 'HistoryError', 'StudioBuildError']

const EXIT = { ok: 0, failed: 1, usage: 2, infra: 3, interrupted: 130 } as const

const version: string = createRequire(import.meta.url)('../package.json').version

const HELP = `es ${version} — eval runner for coding agents

Usage:
  es run [filter...]        Run evals matching config.include; filters are path, name or cell substrings
    --profile <name>        Size the run with a profile from es.config.ts (also ES_PROFILE;
                            default: defaultProfile.ci in CI, else defaultProfile.local)
    --dry-run               Print the plan (evals, cells, attempts, estimate) and exit 0;
                            with --json, as one JSON document (every cell, and what's excluded)
    --force                 Run even when the plan is over budget.attempts
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
  es image build [filter...]
                            Build every image the evals' Docker sandboxes need: ES's image (bakes
                            in the Cursor CLI), from and dockerfile images, install layers
    --dry-run               List the images and how each is made, without building
  es --version
  es --help

Runs are latest, latest~N, a run id (or unique prefix), or a git SHA prefix.
Options: --config <path> (default ./es.config.ts)
Exit codes: 0 passed, 1 failed, 2 usage/config error, 3 infra error, 130 interrupted
`

const { green, red, dim } = colors(!!process.stdout.isTTY && !process.env.NO_COLOR)

/** Set by the first Ctrl-C of `es run`. */
let interrupted = false

function parse(argv: string[]) {
  return parseArgs({
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
      profile: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
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
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv)
  if (values.version) {
    console.log(version)
    return EXIT.ok
  }
  const [command, ...filters] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return values.help ? EXIT.ok : EXIT.usage
  }
  if (command === 'image') {
    if (filters[0] !== 'build') {
      throw new UsageError(
        `Unknown command "image ${filters[0] ?? ''}". Did you mean es image build?`,
      )
    }
    return imageBuildCommand(values, filters.slice(1))
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
  return runCommand(values, filters)
}

type Flags = ReturnType<typeof parse>['values']

/**
 * `es image build`: collects the evals (as `--dry-run` does) and builds every image their Docker
 * sandboxes need; with `--dry-run`, lists them instead. Without a config, just ES's image.
 */
async function imageBuildCommand(flags: Flags, filters: string[]): Promise<number> {
  const { buildImages, imagePlanLines, imageTargets } = await import('./sandbox/images.ts')
  const { docker } = await import('./sandbox.ts')
  let root = process.cwd()
  let uses: Array<{ id: string; sandbox: SandboxDescriptor }> = [{ id: '', sandbox: docker() }]
  if (existsSync(resolve(flags.config))) {
    const setup = await prepareRun({ ...flags, 'dry-run': true })
    const ctx = await startRun(setup)
    const { runId, stagingDir, config, runs, tags, concurrency, profile } = ctx
    root = config.root
    const { runEngine } = await import('./engine/node.ts')
    let planned: PlannedItem[] = []
    await runEngine({
      run: JSON.parse(
        JSON.stringify({ runId, stagingDir, config, runs, tags, concurrency, profile }),
      ),
      filters,
      onPlan: async (collected) => {
        planned = collected.planned.filter((p) => !p.attempt.plan.skip)
        return false
      },
    })
    uses = planned.length
      ? planned.map((p) => ({ id: p.id, sandbox: p.attempt.sandbox }))
      : [{ id: '', sandbox: config.sandbox }]
  }
  const targets = imageTargets(uses)
  if (targets.length === 0) {
    console.log('No eval runs in a Docker sandbox, so there are no images to build.')
    return EXIT.ok
  }
  if (flags['dry-run']) {
    for (const line of await imagePlanLines(targets, root)) console.log(line)
    return EXIT.ok
  }
  const built = await buildImages(targets, root, (line) => console.log(dim(line)))
  for (const { id, image } of built) {
    console.log(
      green(`${id}: ${image.ref}`) + dim(` ${image.id.replace(/^sha256:/, '').slice(0, 12)}`),
    )
  }
  return EXIT.ok
}

/** `es run`: check, plan, run the engine, then write the run and pick the exit code. */
async function runCommand(flags: Flags, filters: string[]): Promise<number> {
  const setup = await prepareRun(flags)
  const ctx = await startRun(setup)
  const { engineVersions } = await import('./engine/node.ts')
  const renderer = createRenderer({
    // The JSON plan is the only output of `--dry-run --json`.
    out: setup.json ? { write: () => true } : process.stdout,
    output: setup.output,
    harness: setup.config.harness[0]?.kind ?? 'agent',
    attemptDir: (id, cell, n) =>
      relative(
        process.cwd(),
        join(ctx.scratch, ctx.runId, evalSlug(id), evalSlug(cell), String(n)),
      ),
  })
  let executed: Awaited<ReturnType<typeof executeRun>>
  try {
    executed = await executeRun(ctx, setup, filters, renderer)
  } catch (error) {
    renderer.close()
    await rm(ctx.stagingDir, { recursive: true, force: true })
    throw error
  }
  const { engineRun, plan, sandboxVersions, budgetReached } = executed
  if (engineRun.stopped || !plan) {
    renderer.close()
    return EXIT.ok
  }

  const { lockfiles } = await import('./history/state.ts')
  const { writeScratchRun } = await import('./results.ts')
  const run = await writeScratchRun({
    ctx,
    author: ctx.author,
    engine: engineRun,
    startedAt: ctx.startedAt,
    endedAt: new Date(),
    interrupted: interrupted || engineRun.cancelled,
    budgetReached: budgetReached(),
    plan,
    es: version,
    enginePackages: engineVersions,
    sandbox: sandboxVersions,
    worktreePatch: ctx.worktreePatch,
    lockfiles: await lockfiles(ctx.config.root),
    git: ctx.git,
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

  const { config } = ctx
  const mode = setup.record
  const autoRecord = flags.record || mode === 'always' || (mode === 'ci' && inCI())
  if (autoRecord && record.status === 'complete') {
    const { record: recordCmd } = await import('./commands.ts')
    console.log(await recordCmd(config, record.runId, flags))
  }

  if (interrupted || engineRun.cancelled) return EXIT.interrupted
  const outcomes = record.evals.map((e) => e.outcome)
  if (outcomes.includes('fail') || engineRun.unhandledErrors.length > 0) return EXIT.failed
  if (record.status === 'budget') return EXIT.failed
  if (outcomes.includes('infra_error')) return EXIT.infra
  return EXIT.ok
}

/** Everything that can fail before the evals are collected: output mode, config, profile, flags. */
async function prepareRun(flags: Flags) {
  const output = resolveOutput({
    flags: {
      ui: flags.ui,
      logOrder: flags['log-order'],
      logPrefix: flags['log-prefix'],
      outputLogs: flags['output-logs'],
    },
    env: process.env,
    isTTY: !!process.stdout.isTTY,
    agent: detectAgent().name,
  })
  if (flags.json && !flags['dry-run']) {
    throw new UsageError(
      'es run --json only prints the plan: add --dry-run. A run writes its record to .es/runs; read it with es show --json.',
    )
  }
  loadEnvFiles(process.cwd())
  const named = flags.profile ?? (process.env.ES_PROFILE || undefined)
  const config = await loadConfig(flags.config, 'run', named)
  const profile = selectProfile(config, flags.profile)
  let runs: number | undefined
  if (flags.runs !== undefined) {
    runs = Number(flags.runs)
    if (!(Number.isInteger(runs) && runs >= 1)) {
      throw new UsageError(`--runs must be a whole number of at least 1 (got ${flags.runs})`)
    }
  }
  const sandboxes = [
    config.sandbox,
    ...(profile?.defaults.sandbox ? [profile.defaults.sandbox] : []),
  ]
  const concurrency = await resolveConcurrency(config, flags.concurrency, async () => {
    if (flags['dry-run'] || !sandboxes.some((s) => s.kind === 'docker')) return hostCapacity()
    const { dockerCapacity } = await import('@evalsuite/sandbox-docker')
    return (await dockerCapacity()) ?? hostCapacity()
  })
  return {
    output,
    config,
    profile,
    runs,
    tags: [...(flags.tag ?? []), ...(profile?.tags ?? [])],
    concurrency,
    budget: profile?.budget ?? config.budget,
    record: profile?.record ?? config.record,
    dryRun: !!flags['dry-run'],
    json: !!flags.json,
    force: !!flags.force,
  }
}

type Prepared = Awaited<ReturnType<typeof prepareRun>>

type StartedRun = RunContext & {
  startedAt: Date
  git: GitInfo | null
  worktreePatch: Buffer | null
  author: string
  /** `.es/runs`, where the run is written. */
  scratch: string
}

/** The run's id and the state it starts from: commit, uncommitted changes, author. */
async function startRun({
  config,
  profile,
  runs,
  tags,
  concurrency,
}: Prepared): Promise<StartedRun> {
  const startedAt = new Date()
  const git = await gitInfo(config.root, [config.history.dir])
  const { worktreePatch } = await import('./history/state.ts')
  const patch = git?.dirty ? await worktreePatch(config.root, [config.history.dir]) : null
  const who = await author(config.root)
  const { stagingDir, sweepStaging } = await import('./results.ts')
  const { scratchDir } = await import('./history/files.ts')
  const scratch = scratchDir(config.root)
  // Run ids sort in run order, so a second run in the same second takes the next second's id,
  // whatever its commit or author.
  const stamps = new Set(
    [scratch, config.history.dir].flatMap((dir) =>
      existsSync(dir) ? readdirSync(dir).map((name) => name.slice(0, RUN_STAMP_LENGTH)) : [],
    ),
  )
  let runId = newRunId(startedAt, git?.sha ?? null, who)
  for (let n = 1; stamps.has(runId.slice(0, RUN_STAMP_LENGTH)); n++) {
    runId = newRunId(new Date(startedAt.getTime() + n * 1000), git?.sha ?? null, who)
  }
  await sweepStaging(config.root)
  return {
    runId,
    // Workers create it with their first record; a run that never starts leaves nothing behind.
    stagingDir: stagingDir(config.root, runId),
    config,
    runs,
    tags,
    concurrency,
    profile,
    startedAt,
    git,
    worktreePatch: patch,
    author: who,
    scratch,
  }
}

function noMatch(config: StartedRun['config'], filters: string[], tags: string[]) {
  const narrowed = [
    filters.length ? `filter "${filters.join(' ')}"` : '',
    tags.length ? `tags ${tags.join(', ')}` : '',
  ].filter(Boolean)
  return new UsageError(
    `No evals matched ${config.include.join(', ')}${narrowed.length ? ` with ${narrowed.join(' and ')}` : ''}`,
  )
}

/**
 * Collects the evals and prints the plan; stops there for `--dry-run`, or on a budget, credential
 * or Docker problem (exit 2). Then runs the engine with live output and Ctrl-C handling.
 */
async function executeRun(
  ctx: StartedRun,
  setup: Prepared,
  filters: string[],
  renderer: ReturnType<typeof createRenderer>,
) {
  const { runId, stagingDir, config, runs, tags, concurrency, profile } = ctx
  const { runEngine } = await import('./engine/node.ts')
  const { buildPlan, checkAttemptBudget, planDocument, planLine, planTable } = await import(
    './plan.ts'
  )
  let plan: RunPlan | undefined
  let sandboxVersions: SandboxVersions = { images: [] }
  let reached = false
  let budgetTimer: NodeJS.Timeout | undefined
  const onPlan = async ({ planned, excluded, matched }: CollectedPlan) => {
    if (matched === 0) throw noMatch(config, filters, tags)
    plan = await buildPlan({
      planned,
      profile,
      budget: setup.budget,
      concurrency,
      root: config.root,
      historyDir: config.history.dir,
    })
    if (setup.json) {
      const { imageStages, imageTargets } = await import('./sandbox/images.ts')
      const targets = imageTargets(
        planned
          .filter((p) => !p.attempt.plan.skip)
          .map((p) => ({ id: p.id, sandbox: p.attempt.sandbox })),
      )
      const images = await Promise.all(
        targets.map(async (t) => ({
          id: t.id,
          evals: t.evals,
          stages: await imageStages(t, config.root),
        })),
      )
      const doc = planDocument(plan, planned, excluded, images)
      process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`)
      return false
    }
    const lines = [planLine(plan)]
    if (setup.dryRun) lines.push(...planTable(plan))
    lines.push(...plan.warnings.map((w) => `warning: ${w}`))
    lines.push(...plan.hints.map((h) => `hint: ${h}`))
    renderer.onEvent({ type: 'plan', at: Date.now(), lines })
    if (setup.dryRun) return false
    checkAttemptBudget(plan, setup.force)
    const missing = missingCredentials(config, process.env, {
      harnessKinds: plan.harnessKinds,
      profile,
    })
    if (missing.length) {
      throw new UsageError(
        `Missing credentials: ${missing.join(', ')}. Set them in the environment or .env.local.`,
      )
    }
    sandboxVersions = await preflight(plan.sandboxes)
    return true
  }
  // budget.duration counts from the first attempt's start, not from collecting the files.
  const startBudget = () => {
    const { duration } = setup.budget
    if (duration === undefined || budgetTimer) return
    budgetTimer = setTimeout(() => {
      reached = true
      mkdirSync(stagingDir, { recursive: true })
      writeFileSync(
        budgetMarker(stagingDir),
        `The run reached budget.duration ${duration} before this attempt started`,
      )
      renderer.onEvent({
        type: 'notice',
        at: Date.now(),
        level: 'warn',
        text: `Budget: ${duration} reached; running attempts finish, queued ones are skipped`,
      })
    }, parseDuration(duration))
    budgetTimer.unref()
  }
  let engineRun: EngineRun
  try {
    engineRun = await runEngine({
      // Provided to every worker, so only what evals need; not the worktree patch. Plain data:
      // an environment's `extend` method doesn't cross to the workers.
      run: JSON.parse(
        JSON.stringify({ runId, stagingDir, config, runs, tags, concurrency, profile }),
      ),
      filters,
      onPlan,
      onRunStart: (files) =>
        renderer.onEvent({
          type: 'run-start',
          at: Date.now(),
          version,
          files,
          harness: config.harness.map(harnessId).join(', '),
          sandbox: sandboxId(config.sandbox),
          concurrency,
        }),
      onEvent: (e) => {
        if (e.type === 'eval-start') startBudget()
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
  } finally {
    clearTimeout(budgetTimer)
  }
  if (engineRun.noFiles || (!engineRun.stopped && engineRun.evals.length === 0 && !interrupted)) {
    throw noMatch(config, filters, tags)
  }
  return { engineRun, plan, sandboxVersions, budgetReached: () => reached }
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
