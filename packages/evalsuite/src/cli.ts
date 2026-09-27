#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { appendFile, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { inspect } from 'node:util'
import { detectAgent } from 'std-env'
import { parseCli } from './cli-parse.ts'
import { type Flags, helpText } from './cli-spec.ts'
import {
  configLabel,
  configPathFor,
  findConfig,
  hostCapacity,
  loadConfig,
  malformedCredentials,
  missingCredentials,
  parseDuration,
  resolveConcurrency,
  selectProfile,
  UsageError,
} from './config.ts'
import { budgetMarker } from './engine/budget.ts'
import type { CollectedPlan, EngineRun, PlannedItem } from './engine/node.ts'
import { inCI, loadEnvFiles } from './env.ts'
import { author, gitInfo, runnerInfo } from './history/provenance.ts'
import type { GitInfo } from './history/types.ts'
import { evalSlug, newRunId, RUN_STAMP_LENGTH } from './ids.ts'
import { type LiveProgressWriter, writeLiveProgress } from './live.ts'
import { harnessId, sandboxId } from './options.ts'
import type { RunPlan } from './plan.ts'
import { preflight, type SandboxVersions } from './preflight.ts'
import { redactSecrets, registerSecret } from './redact.ts'
import { logInvocation } from './report/invocations.ts'
import { commandOf, redactArgv } from './report/scrub.ts'
import type { CliInvocation } from './report/types.ts'
import type { HarnessDescriptor, RunContext, SandboxDescriptor } from './types.ts'
import { colors } from './ui/colors.ts'
import { createRenderer, resolveOutput } from './ui/index.ts'
import { runOutcome } from './view/model.ts'

const HISTORY_COMMANDS = {
  record: 1,
  history: 1,
  show: 1,
  compare: 1,
  checkout: 1,
  query: 1,
  analyze: 1,
}

const EXPECTED_ERRORS = ['CommandError', 'RefError', 'HistoryError', 'StudioBuildError']

const EXIT = { ok: 0, failed: 1, usage: 2, infra: 3, interrupted: 130, terminated: 143 } as const

const version: string = createRequire(import.meta.url)('../package.json').version

const HELP = helpText(version)

const { green, red, dim } = colors(!!process.stdout.isTTY && !process.env.NO_COLOR)

const startedAt = Date.now()
const argv = process.argv.slice(2)
/** What the invocation log needs from the command as it goes. */
const invocation: { flags?: Flags; runId: string | null; unhandledErrors: string[] } = {
  runId: null,
  unhandledErrors: [],
}

/** Set by the first Ctrl-C or SIGTERM of `es run`. */
let interrupted = false
/** The last signal that cancelled the run: 130 after SIGINT, 143 after SIGTERM. */
let stopCode: number = EXIT.interrupted

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseCli(argv)
  invocation.flags = values
  if (values.version) {
    console.log(version)
    return EXIT.ok
  }
  const [command, ...filters] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return values.help ? EXIT.ok : EXIT.usage
  }
  if (command === 'init') {
    const { initCommand } = await import('./init.ts')
    return initCommand(values, filters, {
      out: (s) => console.log(s),
      input: process.stdin,
      output: process.stdout,
      cwd: process.cwd(),
    })
  }
  if (command === 'doctor') {
    const { doctorCommand } = await import('./doctor.ts')
    return doctorCommand(values, {
      out: (s) => console.log(s),
      color: !!process.stdout.isTTY && !process.env.NO_COLOR,
      confirm: process.stdin.isTTY && process.stdout.isTTY ? confirm : undefined,
    })
  }
  if (command === 'report') {
    const { reportCommand } = await import('./report/command.ts')
    return reportCommand(values, filters, {
      out: (s) => console.log(s),
      err: (s) => console.error(dim(s)),
      interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
      confirm: process.stdin.isTTY && process.stdout.isTTY ? confirm : undefined,
    })
  }
  const configPath = configPathFor(values.config)
  if (command === 'image') {
    if (filters[0] !== 'build') {
      throw new UsageError(
        `Unknown command "image ${filters[0] ?? ''}". Did you mean es image build?`,
      )
    }
    return imageBuildCommand(values, configPath, filters.slice(1))
  }
  if (command === 'studio') {
    const config = await loadConfig(configPath, 'studio')
    const { studioCommand } = await import('./studio/command.ts')
    return studioCommand({ config, flags: values, version, build: filters[0] === 'build' })
  }
  if (command in HISTORY_COMMANDS) {
    const config = await loadConfig(configPath, command)
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
      case 'query': {
        const { queryCommand } = await import('./query.ts')
        return queryCommand({ ...ctx, err: (s: string) => console.error(dim(s)) }, filters)
      }
      case 'analyze': {
        loadEnvFiles(configPath)
        const { analyzeCommand } = await import('./analysis/command.ts')
        return analyzeCommand({ ...ctx, err: (s: string) => console.error(dim(s)) }, filters)
      }
    }
  }
  if (command === 'clean') return cleanCommand(values, configPath)
  if (command !== 'run') throw new UsageError(`Unknown command "${command}". Run es --help.`)
  return runCommand(values, configPath, filters)
}

/** Asks a yes/no question on the terminal; anything but y or yes is no. */
async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

/** `es clean`: removes local debug data, all of it or all but the newest `--keep` runs. */
async function cleanCommand(flags: Flags, configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath, 'clean')
  let keep = 0
  if (flags.keep !== undefined) {
    keep = Number(flags.keep)
    if (!(Number.isInteger(keep) && keep >= 0)) {
      throw new UsageError(`--keep must be a whole number (got ${flags.keep})`)
    }
  }
  const { debugRoot, pruneDebug } = await import('./debug/files.ts')
  const { formatBytes } = await import('./view/debug.ts')
  const { runs, bytes } = await pruneDebug(config.root, keep)
  const where = relative(process.cwd(), debugRoot(config.root)) || '.'
  console.log(
    runs.length
      ? `Removed debug data for ${runs.length} run${runs.length === 1 ? '' : 's'} (${formatBytes(bytes)}) from ${where}`
      : `No debug data to remove in ${where}`,
  )
  if (flags.images) {
    const { pruneImages } = await import('@evalsuite/sandbox-docker')
    const { requireDocker } = await import('./sandbox/providers.ts')
    await requireDocker()
    const removed = await pruneImages()
    console.log(
      removed
        ? `Removed ${removed} image${removed === 1 ? '' : 's'} ES built that nothing uses`
        : 'No leftover images to remove',
    )
  }
  return EXIT.ok
}

/** `-v` is 1 and `-vv` (or `--trace`) is 2. */
function verbosityOf(flags: Flags): 0 | 1 | 2 {
  if (flags.trace) return 2
  return Math.min(2, flags.verbose?.length ?? 0) as 0 | 1 | 2
}

/**
 * `es image build`: collects the evals (as `--dry-run` does) and builds every image their Docker
 * sandboxes need; with `--dry-run`, lists them instead. Without a config, just ES's image.
 */
async function imageBuildCommand(
  flags: Flags,
  configPath: string | undefined,
  filters: string[],
): Promise<number> {
  const { buildImages, imagePlanLines, imageTargets } = await import('./sandbox/images.ts')
  const { docker } = await import('./sandbox.ts')
  let root = process.cwd()
  const { fakeHarness } = await import('./harness.ts')
  // The fake harness runs in Cursor's image, so without a config this builds ES's default image.
  let uses: Array<{ id: string; harness: HarnessDescriptor; sandbox: SandboxDescriptor }> = [
    { id: '', harness: fakeHarness(), sandbox: docker() },
  ]
  if (configPath) {
    const setup = await prepareRun({ ...flags, 'dry-run': true }, configPath)
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
        if (collected.unmatched.length) throw unmatchedFilter(config, collected.unmatched)
        planned = collected.planned.filter((p) => !p.attempt.plan.skip)
        return false
      },
    })
    uses = planned.length
      ? planned.map((p) => ({ id: p.id, harness: p.attempt.harness, sandbox: p.attempt.sandbox }))
      : config.harness.map((harness) => ({ id: '', harness, sandbox: config.sandbox }))
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
async function runCommand(
  flags: Flags,
  configPath: string | undefined,
  filters: string[],
): Promise<number> {
  const setup = await prepareRun(flags, configPath)
  const ctx = await startRun(setup)
  invocation.runId = ctx.runId
  const { engineVersions } = await import('./engine/node.ts')
  const renderer = createRenderer({
    // The JSON plan is the only output of `--dry-run --json`.
    out: setup.json ? { write: () => true } : process.stdout,
    output: setup.output,
    verbosity: ctx.verbosity ?? 0,
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
  const { engineRun, plan, sandboxVersions, budgetReached, live } = executed
  invocation.unhandledErrors = engineRun.unhandledErrors
  if ((interrupted || engineRun.cancelled) && plan?.sandboxes.some((s) => s.kind === 'docker')) {
    const { removeRunContainers } = await import('./sandbox/docker.ts')
    await removeRunContainers(ctx.runId)
  }
  if (engineRun.stopped || !plan) {
    live?.remove()
    renderer.close()
    return EXIT.ok
  }

  const { lockfiles } = await import('./history/state.ts')
  const { writeScratchRun } = await import('./results.ts')
  const run = await writeScratchRun(
    {
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
    },
    // Until the record lands, the studio shows the run as live.
    () => live?.stop(),
  )
  const { record } = run
  const { pruneDebug } = await import('./debug/files.ts')
  await pruneDebug(ctx.config.root, ctx.config.debug.keep).catch(() => {})
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
  // A run budget.duration stopped is recorded too, as status `budget`: it's what the budget
  // allowed, and compare never takes an incomplete run as its base. An interrupted one isn't.
  if (autoRecord && record.status !== 'interrupted') {
    const { record: recordCmd } = await import('./commands.ts')
    const allow = record.status === 'budget' ? { 'allow-incomplete': true } : {}
    console.log(await recordCmd(config, record.runId, { ...flags, ...allow }))
  }

  if (interrupted || engineRun.cancelled) return stopCode
  if (engineRun.unhandledErrors.length > 0) return EXIT.failed
  // The studio shows the same outcome for the run.
  const outcome = runOutcome(record)
  return outcome === 'fail' ? EXIT.failed : outcome === 'infra_error' ? EXIT.infra : EXIT.ok
}

/** Everything that can fail before the evals are collected: output mode, config, profile, flags. */
async function prepareRun(flags: Flags, configPath: string | undefined) {
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
  loadEnvFiles(configPath)
  const named = flags.profile ?? (process.env.ES_PROFILE || undefined)
  const config = await loadConfig(configPath, 'run', named)
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
    // Sized from the Docker VM when Docker answers, as a real run is, so --dry-run shows the same.
    if (!sandboxes.some((s) => s.kind === 'docker')) return hostCapacity()
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
    verbosity: verbosityOf(flags),
    configFile: configPath && configLabel(configPath),
    /** Named in the plan line when the project root isn't the current directory. */
    configElsewhere: !!configPath && dirname(configPath) !== process.cwd(),
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
  verbosity,
  configFile,
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
    verbosity,
    configFile,
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

function unmatchedFilter(config: StartedRun['config'], parts: string[]) {
  const which = parts.map((p) => `"${p}"`).join(', ')
  return new UsageError(
    `filter ${which} ${parts.length === 1 ? 'matches' : 'match'} no eval file, eval name or cell in ${config.include.join(', ')}`,
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
  const { runId, stagingDir, config, runs, tags, concurrency, profile, verbosity, configFile } = ctx
  const { runEngine } = await import('./engine/node.ts')
  const { buildPlan, checkAttemptBudget, planDocument, planLine, planTable } = await import(
    './plan.ts'
  )
  let plan: RunPlan | undefined
  let sandboxVersions: SandboxVersions = { images: [] }
  let preflightStop: Error | undefined
  let reached = false
  let budgetTimer: NodeJS.Timeout | undefined
  let toRun: PlannedItem[] = []
  let live: LiveProgressWriter | undefined
  const onPlan = async ({ planned, excluded, matched, unmatched }: CollectedPlan) => {
    if (unmatched.length) throw unmatchedFilter(config, unmatched)
    if (matched === 0) throw noMatch(config, filters, tags)
    toRun = planned
    for (const p of planned)
      for (const name of p.attempt.secretVars) registerSecret(process.env[name])
    plan = await buildPlan({
      planned,
      profile,
      budget: setup.budget,
      concurrency,
      root: config.root,
      historyDir: config.history.dir,
    })
    const { imageStages, imageTargets } = await import('./sandbox/images.ts')
    const targets = imageTargets(
      planned
        .filter((p) => !p.attempt.plan.skip)
        .map((p) => ({ id: p.id, harness: p.attempt.harness, sandbox: p.attempt.sandbox })),
    )
    if (setup.json) {
      const images = await Promise.all(
        targets.map(async (t) => ({
          id: t.id,
          harness: t.harness,
          evals: t.evals,
          stages: await imageStages(t, config.root),
        })),
      )
      const doc = planDocument(plan, planned, excluded, images)
      process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`)
      return false
    }
    const lines = [planLine(plan, setup.configElsewhere ? configFile : undefined)]
    if (setup.dryRun) {
      const todos = excluded.filter((e) => e.mode === 'todo').map((e) => e.id)
      lines.push(...planTable(plan, todos))
    }
    lines.push(...plan.warnings.map((w) => `warning: ${w}`))
    lines.push(...plan.hints.map((h) => `hint: ${h}`))
    renderer.onEvent({
      type: 'plan',
      at: Date.now(),
      lines,
      sandboxWarnings: plan.sandboxWarnings,
    })
    if (setup.dryRun) return false
    checkAttemptBudget(plan, setup.force, config.file)
    const missing = missingCredentials(config, process.env, {
      harnessKinds: plan.harnessKinds,
      profile,
    })
    if (missing.length) {
      throw new UsageError(
        `Missing credentials: ${missing.join(', ')}. Set them in the environment or .env.local.`,
      )
    }
    const malformed = malformedCredentials(config, process.env, {
      harnessKinds: plan.harnessKinds,
    })
    if (malformed.length) {
      throw new UsageError(
        `Credentials with whitespace or a line break in them: ${malformed.join(', ')}. A key copied from a wrapped terminal line picks these up; set it again as one line.`,
      )
    }
    try {
      sandboxVersions = await preflight(
        planned
          .filter((p) => !p.attempt.plan.skip)
          .map((p) => ({
            harness: p.attempt.harness,
            sandbox: p.attempt.sandbox,
            setBy: p.attempt.setBy,
          })),
        {
          root: config.root,
          runId,
          onEvent: (e) => renderer.onEvent({ type: 'prepare', at: Date.now(), ...e }),
        },
      )
    } catch (error) {
      // Thrown from here, the engine would report it as its own error; stop it cleanly instead.
      if ((error as Error).name !== 'PreflightInfraError') throw error
      preflightStop = error as Error
      return false
    }
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
        JSON.stringify({
          runId,
          stagingDir,
          config,
          runs,
          tags,
          concurrency,
          profile,
          verbosity,
          configFile,
        }),
      ),
      filters,
      onPlan,
      onRunStart: (files) => {
        live = writeLiveProgress({
          dir: stagingDir,
          runId,
          startedAt: ctx.startedAt,
          planned: toRun,
        })
        renderer.onEvent({
          type: 'run-start',
          at: Date.now(),
          version,
          files,
          harness: (plan?.harnesses ?? config.harness.map(harnessId)).join(', '),
          sandbox: sandboxId(config.sandbox),
          concurrency,
        })
      },
      onEvent: (e) => {
        if (e.type === 'eval-start') {
          startBudget()
          live?.start(e.key, e.at)
        }
        if (e.type === 'eval-end') live?.end(e.result)
        // Attempts cut short by Ctrl-C are reported from the merged record, in the summary.
        if (interrupted && e.type === 'eval-end' && e.result.state === 'skipped') return
        renderer.onEvent(e)
      },
      // SIGTERM (docker stop, a CI runner's cancel) cancels like Ctrl-C.
      onCancellable: (cancel) => {
        const onSignal = (signal: NodeJS.Signals) => {
          stopCode = signal === 'SIGTERM' ? EXIT.terminated : EXIT.interrupted
          if (interrupted) {
            renderer.close()
            process.exit(stopCode)
          }
          interrupted = true
          live?.phase('cancelling')
          renderer.onEvent({
            type: 'notice',
            at: Date.now(),
            level: 'warn',
            text: 'Cancelling: stopping agents and destroying sandboxes (Ctrl-C again to force)',
          })
          cancel()
        }
        process.on('SIGINT', onSignal)
        process.on('SIGTERM', onSignal)
      },
    })
    live?.phase('finishing')
  } catch (error) {
    live?.remove()
    throw error
  } finally {
    clearTimeout(budgetTimer)
    const { removePrepared } = await import('./sandbox/preflight.ts')
    removePrepared(config.root, runId)
  }
  if (preflightStop) throw preflightStop
  if (engineRun.noFiles || (!engineRun.stopped && engineRun.evals.length === 0 && !interrupted))
    live?.remove()
  if (engineRun.noFiles && !filters.length && !tags.length) {
    throw new UsageError(
      `No eval files match ${config.include.join(', ')} (config.include) in ${config.root}. Name eval files to match it, or set include in ${config.file}.`,
    )
  }
  if (engineRun.noFiles || (!engineRun.stopped && engineRun.evals.length === 0 && !interrupted)) {
    throw noMatch(config, filters, tags)
  }
  return { engineRun, plan, sandboxVersions, budgetReached: () => reached, live }
}

// `es run | head` closes stdout early; that isn't an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

/**
 * Logs the command for `es report` and, when it looks like ES broke (a crash, an unexpected
 * error or an infra error), prints one line suggesting `es report`. Not for agents or JSON.
 */
function finish(code: number, error?: unknown, kind?: NonNullable<CliInvocation['error']>['kind']) {
  const flags = invocation.flags
  let root = process.cwd()
  try {
    const configPath = flags ? configPathFor(flags.config) : findConfig()
    if (configPath) root = dirname(configPath)
  } catch {}
  const command = commandOf(argv)
  logInvocation(root, {
    at: new Date(startedAt).toISOString(),
    es: version,
    argv: redactArgv(argv),
    command,
    exitCode: code,
    durationMs: Date.now() - startedAt,
    runId: invocation.runId,
    error:
      error && kind
        ? {
            kind,
            name: error instanceof Error ? error.name : 'Error',
            message: redactSecrets(error instanceof Error ? error.message : String(error)),
            stack: error instanceof Error && error.stack ? redactSecrets(error.stack) : null,
          }
        : null,
    unhandledErrors: invocation.unhandledErrors.map((e) => redactSecrets(e)),
  })
  const broke = kind === 'crash' || code === EXIT.infra
  const quiet =
    !!process.env.ES_NO_REPORT_HINT ||
    command === 'report' ||
    !!flags?.json ||
    flags?.ui === 'agent' ||
    process.env.ES_UI === 'agent' ||
    (!flags?.ui && !process.env.ES_UI && !!detectAgent().name)
  if (broke && !quiet) {
    console.error(
      dim(
        'hint: if this looks like a bug in ES, es report collects a redacted report to file (ES_NO_REPORT_HINT=1 hides this)',
      ),
    )
  }
}

// An error nothing awaited, from ES or from code the config runs, ends the run as an infra error.
const crash = (error: unknown) => {
  console.error(red(`es: ${redactSecrets(error instanceof Error ? error.message : String(error))}`))
  if (process.env.ES_DEBUG) console.error(redactSecrets(inspect(error)))
  finish(EXIT.infra, error, 'crash')
  process.exit(EXIT.infra)
}
process.on('unhandledRejection', crash)
process.on('uncaughtException', crash)

run(process.argv.slice(2)).then(
  (code) => {
    finish(code)
    process.exitCode = code
  },
  (error: unknown) => {
    const name = (error as Error).name
    const expected =
      error instanceof UsageError ||
      EXPECTED_ERRORS.includes(name) ||
      name === 'PreflightInfraError'
    console.error(red(`es: ${redactSecrets((error as Error).message)}`))
    if (!expected && process.env.ES_DEBUG) console.error(redactSecrets(inspect(error)))
    const code = name === 'PreflightInfraError' ? EXIT.infra : EXIT.usage
    finish(code, error, error instanceof UsageError ? 'usage' : expected ? 'expected' : 'crash')
    process.exitCode = code
  },
)
