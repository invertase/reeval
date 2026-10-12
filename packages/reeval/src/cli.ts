import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { appendFile, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { inspect } from 'node:util'
import { detectAgent } from 'std-env'
import type { NoteRun } from './analysis/agent/index.ts'
import { parseCli } from './cli-parse.ts'
import { type Flags, helpText } from './cli-spec.ts'
import type { EvalQuestions, questionRunner } from './compare/questions.ts'
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
import { environmentSandbox, workspaceLabel } from './environment.ts'
import { author, gitInfo, runnerInfo, runtimeInfo } from './history/provenance.ts'
import type { GitInfo } from './history/types.ts'
import { evalSlug, fromCwd, newRunId, RUN_STAMP_LENGTH } from './ids.ts'
import { type LiveProgressWriter, writeLiveProgress } from './live.ts'
import { harnessId, sandboxId } from './options.ts'
import type { RunPlan } from './plan.ts'
import { preflight, type SandboxVersions } from './preflight.ts'
import { redactSecrets, registerSecret } from './redact.ts'
import { logInvocation } from './report/invocations.ts'
import { commandOf, redactArgv } from './report/scrub.ts'
import type { CliInvocation } from './report/types.ts'
import { PACKAGE_VERSION } from './root.ts'
import {
  completedKeysFor,
  loadPrevious,
  prepareResume,
  resolveResume,
  writeCurrent,
} from './resume.ts'
import { clip } from './text.ts'
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

const version = PACKAGE_VERSION

const HELP = helpText(version)

const { green, red, dim } = colors(!!process.stdout.isTTY && !process.env.NO_COLOR)

const startedAt = Date.now()
const argv = process.argv.slice(2)
/** What the invocation log needs from the command as it goes. */
const invocation: { flags?: Flags; runId: string | null; unhandledErrors: string[] } = {
  runId: null,
  unhandledErrors: [],
}

/** Set by the first Ctrl-C or SIGTERM of `reeval run`. */
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
        `Unknown command "image ${filters[0] ?? ''}". Did you mean reeval image build?`,
      )
    }
    return imageBuildCommand(values, configPath, filters.slice(1))
  }
  if (command === 'studio') {
    const config = await loadConfig(configPath, 'studio')
    const { studioCommand } = await import('./studio/command.ts')
    return studioCommand({ config, flags: values, version, build: filters[0] === 'build' })
  }
  if (command === 'mcp') {
    // On stdio, stdout carries the protocol: anything the config prints goes to stderr.
    if (!values.http) console.log = console.info = console.debug = console.error
    const config = await loadConfig(configPath, 'mcp')
    const { mcpCommand } = await import('./mcp/command.ts')
    return mcpCommand({ config, flags: values, version })
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
  if (command !== 'run') throw new UsageError(`Unknown command "${command}". Run reeval --help.`)
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

/** `reeval clean`: removes local debug data, all of it or all but the newest `--keep` runs. */
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
  const where = fromCwd(debugRoot(config.root)) || '.'
  console.log(
    runs.length
      ? `Removed debug data for ${runs.length} run${runs.length === 1 ? '' : 's'} (${formatBytes(bytes)}) from ${where}`
      : `No debug data to remove in ${where}`,
  )
  if (flags.images) {
    const { pruneImages } = await import('@reeval/sandbox-docker')
    const { requireDocker } = await import('./sandbox/providers.ts')
    await requireDocker()
    const removed = await pruneImages()
    console.log(
      removed
        ? `Removed ${removed} image${removed === 1 ? '' : 's'} reeval built that nothing uses`
        : 'No leftover images to remove',
    )
  }
  return EXIT.ok
}

type QuestionRunner = ReturnType<typeof questionRunner>

/** `-v` is 1 and `-vv` (or `--trace`) is 2. */
function verbosityOf(flags: Flags): 0 | 1 | 2 {
  if (flags.trace) return 2
  return Math.min(2, flags.verbose?.length ?? 0) as 0 | 1 | 2
}

/**
 * `reeval image build`: collects the evals (as `--dry-run` does) and builds every image their Docker
 * sandboxes need; with `--dry-run`, lists them instead. `--profile` plans as `reeval run --profile`
 * does. Without a config, just reeval's image.
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
  // The fake harness runs in Cursor's image, so without a config this builds reeval's default image.
  let uses: Array<{ id: string; harness: HarnessDescriptor; sandbox: SandboxDescriptor }> = [
    { id: '', harness: fakeHarness(), sandbox: docker() },
  ]
  if (!configPath && flags.profile) selectProfile(await loadConfig(undefined), flags.profile)
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
  const { PrepareError } = await import('./sandbox/provider.ts')
  let built: Awaited<ReturnType<typeof buildImages>>
  try {
    built = await buildImages(targets, root, {
      log: (line) => console.log(dim(line)),
      force: !!flags.force,
    })
  } catch (error) {
    if (error instanceof PrepareError && error.failure.usage) throw new UsageError(error.message)
    throw error
  }
  // Every image, failed or not, so one broken image doesn't hide the state of the others.
  for (const b of built) {
    if (b.ok) {
      const id = b.image.id.replace(/^sha256:/, '').slice(0, 12)
      console.log(`${green('✓')} ${green(`${b.id}: ${b.image.ref}`)}${dim(` ${id}`)}`)
      continue
    }
    const uses = b.evals ? ` (${b.evals} eval${b.evals === 1 ? '' : 's'})` : ''
    const [headline = '', ...rest] = b.failure.message.split('\n')
    console.log(`${red('✗')} ${red(`${b.id}${uses}: ${headline}`)}`)
    for (const line of rest) console.log(`  ${line}`)
  }
  const failed = built.filter((b) => !b.ok)
  const n = built.length
  console.log(
    failed.length
      ? red(`${failed.length} of ${n} image${n === 1 ? '' : 's'} failed to build`)
      : dim(`${n} image${n === 1 ? '' : 's'} ready`),
  )
  if (!failed.length) return EXIT.ok
  // A missing docker({ image }) is fixed in the config; anything else is the build's.
  return failed.every((b) => !b.ok && b.failure.usage) ? EXIT.usage : EXIT.infra
}

/** `reeval run`: check, plan, run the engine, then write the run and pick the exit code. */
async function runCommand(
  flags: Flags,
  configPath: string | undefined,
  filters: string[],
): Promise<number> {
  const setup = await prepareRun(flags, configPath)
  const ctx = await startRun(setup)
  invocation.runId = ctx.runId
  if (!setup.dryRun) writeCurrent(setup.config.root, ctx.runId)
  const githubOut = process.env.GITHUB_OUTPUT
  if (githubOut) await appendFile(githubOut, `run-id=${ctx.runId}\n`).catch(() => {})
  const stepStart = process.env.GITHUB_STEP_SUMMARY
  if (stepStart) await appendFile(stepStart, `run ${ctx.runId}\n`).catch(() => {})
  const { engineVersions } = await import('./engine/node.ts')
  const renderer = createRenderer({
    // The JSON plan is the only output of `--dry-run --json`.
    out: setup.json ? { write: () => true } : process.stdout,
    output: setup.output,
    verbosity: ctx.verbosity ?? 0,
    harness: setup.config.harness[0]?.kind ?? 'agent',
    attemptDir: (id, cell, n) =>
      fromCwd(join(ctx.scratch, ctx.runId, evalSlug(id), evalSlug(cell), String(n))),
  })
  let executed: Awaited<ReturnType<typeof executeRun>>
  try {
    executed = await executeRun(ctx, setup, filters, renderer)
  } catch (error) {
    renderer.close()
    if (setup.resume === undefined) await rm(ctx.stagingDir, { recursive: true, force: true })
    throw error
  }
  const { engineRun, plan, sandboxVersions, budgetReached, live, notes, questions } = executed
  invocation.unhandledErrors = engineRun.unhandledErrors
  if ((interrupted || engineRun.cancelled) && plan?.sandboxes.some((s) => s.kind === 'docker')) {
    const { removeRunContainers } = await import('./sandbox/docker.ts')
    await removeRunContainers(ctx.runId)
  }
  if (notes) {
    // Before the record is written: the notes read the staged attempts, which it removes.
    const cancelled = interrupted || engineRun.cancelled
    const written = await notes.finish(cancelled)
    if (!cancelled && written.length) {
      const { notesLine } = await import('./analysis/agent/index.ts')
      const text = notesLine(ctx.config.root, ctx.runId, written)
      renderer.onEvent({ type: 'notice', at: Date.now(), level: 'info', text })
    }
  }
  if (engineRun.stopped || !plan) {
    live?.remove()
    renderer.close()
    return EXIT.ok
  }

  const stopped = interrupted || engineRun.cancelled
  // Asked of attempts that have all finished; a cancelled run answers nothing.
  const answers = questions && !stopped ? await questions.settle() : undefined
  const { lockfiles } = await import('./history/state.ts')
  const { writeScratchRun } = await import('./results.ts')
  const run = await writeScratchRun(
    {
      ctx,
      author: ctx.author,
      engine: engineRun,
      startedAt: ctx.startedAt,
      endedAt: new Date(),
      interrupted: stopped,
      budgetReached: budgetReached(),
      plan,
      es: version,
      runtime: runtimeInfo(),
      language: { name: 'typescript' },
      enginePackages: engineVersions,
      sandbox: sandboxVersions,
      worktreePatch: ctx.worktreePatch,
      lockfiles: await lockfiles(ctx.config.root),
      git: ctx.git,
      previous: ctx.previous,
      previousArtifacts: ctx.previousArtifacts,
      runner: runnerInfo(),
      ...(answers?.size ? { answers } : {}),
    },
    // Until the record lands, the studio shows the run as live.
    () => live?.stop(),
  )
  const { record } = run
  // After the record is written: the summary reads it as reeval analyze would.
  if (notes && !stopped) {
    const { summarizeRun } = await import('./analysis/agent/index.ts')
    const { resolveAnalysisModel } = await import('./analysis/model.ts')
    const model = resolveAnalysisModel(ctx.config, 'agent')
    const { level, text } = await summarizeRun(ctx.config, record.runId, model)
    renderer.onEvent({ type: 'notice', at: Date.now(), level, text })
  }
  const { pruneDebug } = await import('./debug/files.ts')
  await pruneDebug(ctx.config.root, ctx.config.debug.keep).catch(() => {})
  const summary = run.artifactDir ? join(run.artifactDir, 'summary.md') : run.recordPath
  renderer.onEvent({
    type: 'run-end',
    at: Date.now(),
    record,
    summaryPath: fromCwd(summary),
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
      'reeval run --json only prints the plan: add --dry-run. A run writes its record to .reeval/runs; read it with reeval show --json.',
    )
  }
  loadEnvFiles(configPath)
  const named = flags.profile ?? (process.env.REEVAL_PROFILE || undefined)
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
    environmentSandbox(config.environment, config.sandbox),
    ...(profile?.defaults.environment
      ? [environmentSandbox(profile.defaults.environment, config.sandbox)]
      : []),
  ]
  const concurrency = await resolveConcurrency(config, flags.concurrency, async () => {
    // Sized from the Docker VM when Docker answers, as a real run is, so --dry-run shows the same.
    if (!sandboxes.some((s) => s.kind === 'docker')) return hostCapacity()
    const { dockerCapacity } = await import('@reeval/sandbox-docker')
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
    /** `undefined` is a new run; `''` is newest resumable; a string is a run id or prefix. */
    resume: flags.resume,
  }
}

type Prepared = Awaited<ReturnType<typeof prepareRun>>

type StartedRun = RunContext & {
  startedAt: Date
  git: GitInfo | null
  worktreePatch: Buffer | null
  author: string
  /** `.reeval/runs`, where the run is written. */
  scratch: string
  previous: import('./history/types.ts').RunRecord | null
  previousArtifacts: string | null
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
  resume,
  dryRun,
}: Prepared): Promise<StartedRun> {
  const startedAt = new Date()
  const git = await gitInfo(config.root, [config.history.dir])
  const { worktreePatch } = await import('./history/state.ts')
  const patch = git?.dirty ? await worktreePatch(config.root, [config.history.dir]) : null
  const who = await author(config.root)
  const { stagingDir, sweepStaging } = await import('./results.ts')
  const { scratchDir } = await import('./history/files.ts')
  const scratch = scratchDir(config.root)
  if (resume !== undefined) {
    const target = await resolveResume(config.root, resume || undefined)
    if (!dryRun) await prepareResume(target, config.root)
    await sweepStaging(config.root, target.runId)
    const aside = dryRun
      ? { record: target.previous, artifacts: target.previousArtifacts }
      : await loadPrevious(stagingDir(config.root, target.runId))
    if (!dryRun) {
      try {
        const { removeRunContainers } = await import('./sandbox/docker.ts')
        await removeRunContainers(target.runId)
      } catch {}
    }
    return {
      runId: target.runId,
      stagingDir: stagingDir(config.root, target.runId),
      config,
      runs,
      tags,
      concurrency,
      profile,
      verbosity,
      configFile,
      startedAt: target.startedAt,
      git,
      worktreePatch: patch,
      author: who,
      scratch,
      previous: aside.record ?? target.previous,
      previousArtifacts: aside.artifacts ?? target.previousArtifacts,
    }
  }
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
    previous: null,
    previousArtifacts: null,
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
  const run = JSON.parse(
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
      completed: [] as string[],
    }),
  ) as typeof ctx
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
  let notes: NoteRun | undefined
  let questions: QuestionRunner | undefined
  const onPlan = async ({ planned, excluded, matched, unmatched }: CollectedPlan) => {
    if (unmatched.length) throw unmatchedFilter(config, unmatched)
    if (matched === 0) throw noMatch(config, filters, tags)
    const completed = completedKeysFor(planned, stagingDir, ctx.previous)
    const skipped = planned.map((p) =>
      completed.has(p.key)
        ? {
            ...p,
            attempt: {
              ...p.attempt,
              skip: 'already completed in this run',
              plan: { ...p.attempt.plan, skip: 'already completed in this run' },
            },
          }
        : p,
    )
    toRun = skipped
    for (const p of skipped)
      for (const name of p.attempt.secretVars) registerSecret(process.env[name])
    const asks = skipped.some((p) => !p.attempt.plan.skip && p.attempt.plan.questions?.length)
    const models = asks ? await import('./analysis/model.ts') : undefined
    plan = await buildPlan({
      planned: skipped,
      profile,
      budget: setup.budget,
      concurrency,
      root: config.root,
      historyDir: config.history.dir,
      questionModel: models?.questionModelLabel(config) ?? null,
    })
    plan.runId = runId
    if (completed.size) plan.resume = { runId, completed: completed.size }
    run.completed = [...completed]
    const { imageStages, imageTargets } = await import('./sandbox/images.ts')
    const targets = imageTargets(
      skipped
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
      const doc = planDocument(plan, skipped, excluded, images)
      process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`)
      return false
    }
    const lines = [planLine(plan, setup.configElsewhere ? configFile : undefined, runId)]
    if (setup.dryRun) {
      const todos = excluded.filter((e) => e.mode === 'todo').map((e) => e.id)
      lines.push(...planTable(plan, todos))
      const { imageStatusLines } = await import('./sandbox/images.ts')
      const { dockerAvailable } = await import('@reeval/sandbox-docker')
      if (targets.length && (await dockerAvailable())) {
        lines.push(...(await imageStatusLines(targets, config.root)))
      } else if (targets.length) {
        lines.push('images  not checked: Docker is not running')
      }
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
    const analysis = config.analysis.agent ? await import('./analysis/model.ts') : null
    analysis?.analysisModelName(config, 'agent')
    const questionModels = new Set<string>()
    const asked: EvalQuestions[] = []
    for (const row of plan.rows) {
      if (row.plan.skip || !models) continue
      const questions = (row.plan.questions ?? []).map((q) => ({
        question: q.question,
        model: models.questionModel(config, q, row.id),
      }))
      for (const q of questions) if (typeof q.model === 'string') questionModels.add(q.model)
      if (questions.length) asked.push({ row, questions })
    }
    const missing = missingCredentials(config, process.env, {
      harnesses: plan.harnessDescriptors,
      profile,
      questionModels: [...questionModels],
    })
    if (missing.length) {
      throw new UsageError(
        `Missing credentials: ${missing.join(', ')}. Set them in the environment or .env.local.`,
      )
    }
    const malformed = malformedCredentials(config, process.env, {
      harnesses: plan.harnessDescriptors,
      profile,
      questionModels: [...questionModels],
    })
    if (malformed.length) {
      throw new UsageError(
        `Credentials with whitespace or a line break in them: ${malformed.join(', ')}. A key copied from a wrapped terminal line picks these up; set it again as one line.`,
      )
    }
    if (analysis) {
      const { startNotes } = await import('./analysis/agent/index.ts')
      notes = startNotes({
        config,
        model: analysis.resolveAnalysisModel(config, 'agent'),
        runId,
        stagingDir,
        planned: skipped,
        warn: (text) => renderer.onEvent({ type: 'notice', at: Date.now(), level: 'warn', text }),
      })
    }
    if (asked.length) {
      const { questionRunner } = await import('./compare/questions.ts')
      questions = questionRunner({
        evals: asked,
        stagingDir,
        maxInputTokens: config.analysis.maxInputTokens,
        maxOutputTokens: config.analysis.maxOutputTokens,
        onAnswer: (id, answer) => {
          if (answer.error === undefined) return
          renderer.onEvent({
            type: 'notice',
            at: Date.now(),
            level: 'warn',
            text: `compare question "${clip(answer.question, 80)}" on ${id} failed: ${answer.error}. Outcomes are unchanged.`,
          })
        },
      })
    }
    const { prepareWorkspaces, workspaceKey } = await import('./workspace.ts')
    const live = skipped.filter((p) => !p.attempt.plan.skip)
    const outcomes = await prepareWorkspaces(
      live.flatMap(({ attempt: a }) =>
        a.workspace ? [{ workspace: a.workspace, environment: a.cell.environment }] : [],
      ),
      { root: config.root, runId },
    )
    for (const o of outcomes) {
      const at = Date.now()
      if (o.ok) {
        const text = `workspace ${workspaceLabel(o.workspace)} at ${o.prepared.commit.slice(0, 12)}`
        renderer.onEvent({ type: 'notice', at, level: 'info', text })
        continue
      }
      // Reported like a sandbox that failed to prepare: once, and only its attempts fail.
      const key = workspaceKey(o.workspace)
      const user = live.find(
        (p) => p.attempt.workspace && workspaceKey(p.attempt.workspace) === key,
      )
      if (!user) continue
      const target = {
        kind: 'workspace',
        key: o.label,
        label: `workspace ${o.label}`,
        sandbox: user.attempt.sandbox,
        harness: user.attempt.harness,
        setBy: o.setBy,
        runWide: false,
      }
      renderer.onEvent({
        type: 'prepare',
        at,
        state: 'failed',
        outcome: { target, ok: false, failure: o.failure, ms: 0 },
      })
    }
    try {
      sandboxVersions = await preflight(
        skipped
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
      run,
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
          runId,
        })
      },
      onEvent: (e) => {
        if (e.type === 'eval-start') {
          startBudget()
          live?.start(e.key, e.at)
        }
        if (e.type === 'eval-end') {
          live?.end(e.result)
          notes?.onResult(e.result)
          questions?.onEvalEnd(e.result)
        }
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
          questions?.cancel()
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
    const { removePreparedWorkspaces } = await import('./workspace.ts')
    removePreparedWorkspaces(config.root, runId)
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
  return {
    engineRun,
    plan,
    sandboxVersions,
    budgetReached: () => reached,
    live,
    notes,
    questions,
  }
}

// `reeval run | head` closes stdout early; that isn't an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

/**
 * Logs the command for `reeval report` and, when it looks like reeval broke (a crash, an unexpected
 * error or an infra error), prints one line suggesting `reeval report`. Not for agents or JSON.
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
  const broke = kind === 'crash' || code === EXIT.infra || invocation.unhandledErrors.length > 0
  const quiet =
    !!process.env.REEVAL_NO_REPORT_HINT ||
    command === 'report' ||
    !!flags?.json ||
    flags?.ui === 'agent' ||
    process.env.REEVAL_UI === 'agent' ||
    (!flags?.ui && !process.env.REEVAL_UI && !!detectAgent().name)
  if (broke && !quiet) {
    console.error(
      dim(
        'hint: if this looks like a bug in reeval, reeval report collects a redacted report to file (REEVAL_NO_REPORT_HINT=1 hides this)',
      ),
    )
  }
}

// An error nothing awaited, from reeval or from code the config runs, ends the run as an infra error.
const crash = (error: unknown) => {
  console.error(
    red(`reeval: ${redactSecrets(error instanceof Error ? error.message : String(error))}`),
  )
  if (process.env.REEVAL_DEBUG) console.error(redactSecrets(inspect(error)))
  finish(EXIT.infra, error, 'crash')
  process.exit(EXIT.infra)
}
process.on('unhandledRejection', crash)
process.on('uncaughtException', crash)

// Node exits 0 when nothing is left to wait on, even with the command unfinished: never a pass.
let settled = false
process.on('exit', (code) => {
  // A crash or a forced Ctrl-C exits on purpose, with its own code.
  if (settled || code !== 0) return
  process.stderr.write(
    red(
      "reeval: stopped before it finished: nothing was left for it to wait on. That's a bug in reeval, or in code the config or an eval ran; reeval report collects a redacted report.\n",
    ),
  )
  process.exitCode = EXIT.infra
})

run(process.argv.slice(2))
  .finally(() => {
    settled = true
  })
  .then(
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
      console.error(red(`reeval: ${redactSecrets((error as Error).message)}`))
      if (!expected && process.env.REEVAL_DEBUG) console.error(redactSecrets(inspect(error)))
      const code = name === 'PreflightInfraError' ? EXIT.infra : EXIT.usage
      finish(code, error, error instanceof UsageError ? 'usage' : expected ? 'expected' : 'crash')
      process.exitCode = code
    },
  )
