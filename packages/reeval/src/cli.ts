import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { appendFile, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { inspect } from 'node:util'
import { detectAgent } from 'std-env'
import { parseCli } from './cli-parse.ts'
import { commandHelpText, type Flags, helpText } from './cli-spec.ts'
import { type RunTarget, wantsCloud } from './cloud-run.ts'
import type { EvalQuestions, questionRunner } from './compare/questions.ts'
import {
  configLabel,
  configPathFor,
  defaultConcurrency,
  findConfig,
  givenConcurrency,
  hostCapacity,
  loadConfig,
  malformedCredentials,
  missingCredentials,
  neededCredentials,
  type PlannedJudge,
  parseDuration,
  requireConfig,
  runJudgeModel,
  selectProfile,
  UsageError,
  withProfileHistory,
} from './config.ts'
import { ciRunner, directOnCloud, isDirect, rootlessPodmanSwitch, setupEgress } from './egress.ts'
import { budgetMarker } from './engine/budget.ts'
import type { CollectedPlan, EngineRun, PlannedItem } from './engine/node.ts'
import { inCI, loadEnvFiles } from './env.ts'
import { environmentSandbox, profileSandbox, workspaceLabel } from './environment.ts'
import {
  ATTEMPTS_HEARTBEAT_MS,
  ATTEMPTS_HEARTBEAT_RANGE,
  type AttemptsBeat,
  beatWith,
  displayUrl,
  type EventStream,
  isAttachUrl,
  isEventsUrl,
  notEventStream,
  openEventStream,
  teeRenderer,
} from './events.ts'
import { gatewayScope, resolveModelGateway } from './gateway/models.ts'
import { openRouterFallbacks } from './gateway/openrouter-models.ts'
import { vertexSettingsIn } from './gateway/vertex.ts'
import { author, gitInfo, runnerInfo, runtimeInfo } from './history/provenance.ts'
import type { GitInfo, RunInvocation } from './history/types.ts'
import { cwdIn, fromCwd, newRunId, RUN_ID, RUN_STAMP_LENGTH, relativeFile } from './ids.ts'
import { judgeModelName, unusedGatewayKey } from './judge/index.ts'
import { type LiveKept, type LiveProgressWriter, writeLiveProgress } from './live.ts'
import { checkLimitHarness, harnessId, plannedSandboxes, plannedSandboxIds } from './options.ts'
import type { PlanDocument, RunPlan } from './plan.ts'
import { preflight, type SandboxVersions } from './preflight.ts'
import { isPlaceholder, redactSecrets, registerSecret, stripCredentials } from './redact.ts'
import { logInvocation } from './report/invocations.ts'
import { commandOf, redactArgv } from './report/scrub.ts'
import type { CliInvocation } from './report/types.ts'
import {
  CANCEL_SIGNAL,
  completedKeysFor,
  erroredAttempts,
  eventsFile,
  holdRetry,
  keptAttempts,
  type LeftOut,
  leftOutAttempts,
  liveAttempts,
  loadPrevious,
  noRunHere,
  noteRetries,
  prepareResume,
  previousAttempt,
  pruneEvents,
  type ResumeTarget,
  removeStoppedStaging,
  resolveAttach,
  resolveResume,
  resolveRetry,
  restoreRetry,
  resumeSettings,
  savedFilters,
  savedInvocation,
  stoppedRetry,
  sweepStaging,
  writeCurrent,
} from './resume.ts'
import { PACKAGE_VERSION } from './root.ts'
import {
  capabilitiesOf,
  cleanupRun,
  removeOrphans,
  sandboxCapacity,
  sandboxKind,
} from './sandbox/kinds.ts'
import { heldSecrets, hostEnv, readSecretsFile, SECRETS_SERVICE } from './secrets-file.ts'
import { localStudio } from './store/resolve.ts'
import { isRemote, pullStore, storeCredentials } from './store/sync.ts'
import { clip, formatDuration } from './text.ts'
import { checkTraitKeys, traitFilters, traitFlags } from './traits.ts'
import type {
  CursorEfforts,
  LocalInput,
  ResolvedConfig,
  ResolvedHistory,
  RunContext,
  SandboxDescriptor,
} from './types.ts'
import { colors } from './ui/colors.ts'
import type { RecordedPaths } from './ui/events.ts'
import { createRenderer, resolveOutput } from './ui/index.ts'
import { parseHeartbeat } from './ui/mode.ts'
import { runOutcome } from './view/model.ts'

const HISTORY_COMMANDS = {
  record: 1,
  history: 1,
  show: 1,
  compare: 1,
  checkout: 1,
  query: 1,
  analyze: 1,
  sync: 1,
}

/** The commands that pull a remote store's new runs into its copy before reading it. */
const PULLS = {
  history: 1,
  show: 1,
  compare: 1,
  checkout: 1,
  query: 1,
  analyze: 1,
  mcp: 1,
  'cloud push': 1,
  'studio share': 1,
}

const EXPECTED_ERRORS = [
  'CommandError',
  'RefError',
  'HistoryError',
  'StudioBuildError',
  'NewerSchemaError',
]
/** Errors that exit 3: reeval couldn't reach what the run needs, not a mistake in the command. */
const INFRA_ERRORS = ['PreflightInfraError', 'StoreError', 'EventStreamError', 'CloudError']

const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  infra: 3,
  stopped: 4,
  interrupted: 130,
  terminated: 143,
} as const

const version = PACKAGE_VERSION

const HELP = helpText(version)

const { green, red, dim, yellow } = colors(!!process.stdout.isTTY && !process.env.NO_COLOR)

const startedAt = Date.now()
const argv = process.argv.slice(2)
/** What the invocation log needs from the command as it goes. */
const invocation: {
  flags?: Flags
  runId: string | null
  unhandledErrors: string[]
  /**
   * The exit 3 is the machine's state (a full disk) or the history store's, not a bug: no
   * `reeval report` hint.
   */
  machineState?: boolean
} = {
  runId: null,
  unhandledErrors: [],
}

/** `reeval run --events`: the run's event stream, which ends with the command's exit code. */
let eventStream: EventStream | undefined

/** Set by the first Ctrl-C or SIGTERM of `reeval run`. */
let interrupted = false
/** The last signal that canceled the run: 130 after SIGINT, 143 after SIGTERM. */
let stopCode: number = EXIT.interrupted
/**
 * Set once the attempts and questions are done and whether the run stopped is decided, as
 * live.json turns `finishing`: a signal then has nothing left to cancel.
 */
let finishing = false

/** The other signal this soon after the one that canceled the run is the same Ctrl-C, passed on. */
const SAME_PRESS_MS = 1000

/** What a forced quit leaves, and how to finish or discard it. */
function quitWithoutRecord(runId: string, stagingDir: string): string {
  return [
    `reeval: quit without writing run ${runId}'s record; its workers still destroy their sandboxes.`,
    `  reeval run --resume ${runId} keeps the attempts that finished, runs the rest and writes the record.`,
    `  Deleting ${fromCwd(stagingDir)} discards the run.`,
  ].join('\n')
}

/** Sweeps stale staging, naming each stale run it keeps because it can still be resumed. */
async function sweep(root: string, keep?: string): Promise<void> {
  for (const runId of await sweepStaging(root, keep)) {
    process.stderr.write(
      `reeval: run ${runId} stopped over a day ago and can still be resumed: reeval run --resume ${runId} finishes it, reeval clean --staging deletes it.\n`,
    )
  }
}

/** Removes the sandboxes runs on this host left behind when their process was killed, saying so. */
async function reapOrphans(sandboxes: readonly SandboxDescriptor[]): Promise<void> {
  const removed = await removeOrphans(sandboxes).catch(() => 0)
  if (removed) {
    process.stderr.write(
      `reeval: removed ${removed} sandbox${removed === 1 ? '' : 'es'} a killed reeval left running\n`,
    )
  }
}

async function run(argv: string[]): Promise<number> {
  readSecretsFile()
  const { values, positionals } = parseCli(argv)
  invocation.flags = values
  if (values.version) {
    console.log(version)
    return EXIT.ok
  }
  const [command, ...filters] = positionals
  if (values.help && command) {
    console.log(commandHelpText(version, positionals))
    return EXIT.ok
  }
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
  if (command === 'login' || command === 'logout' || command === 'whoami') {
    const login = await import('./login/command.ts')
    // The platform's URL may be in the project's .env, as it is for a cloud run.
    loadEnvFiles(configPathFor(values.config))
    const { defaultIssueDeps } = await import('./report/issue.ts')
    const io = {
      out: (s: string) => console.log(s),
      err: (s: string) => console.error(dim(s)),
      ...(process.stdout.isTTY && !inCI() && { open: defaultIssueDeps().open }),
    }
    if (command === 'login') return login.loginCommand(io)
    if (command === 'logout') return login.logoutCommand(io)
    return login.whoamiCommand(values, io)
  }
  const configPath = configPathFor(values.config)
  if (command === 'link') {
    loadEnvFiles(configPath)
    const [{ linkCommand }, { projectDirFor }] = await Promise.all([
      import('./link.ts'),
      import('./cloud-project.ts'),
    ])
    return linkCommand(values, {
      out: (s) => console.log(s),
      input: process.stdin,
      output: process.stdout,
      interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
      projectDir: projectDirFor(configPath),
    })
  }
  if (command === 'cloud') {
    const [area, ...args] = filters
    if (
      area !== 'secrets' &&
      area !== 'provider' &&
      area !== 'gateway' &&
      area !== 'push' &&
      area !== 'run'
    ) {
      throw new UsageError(
        `Unknown command "${['cloud', area].filter(Boolean).join(' ')}". Did you mean reeval cloud secrets, provider, gateway, push or run?`,
      )
    }
    if (area === 'push') {
      const config = await historyConfig(configPath, 'cloud push', values.profile, values)
      const [{ pushCommand }, { projectDirFor }] = await Promise.all([
        import('./cloud-push.ts'),
        import('./cloud-project.ts'),
      ])
      return pushCommand(config, values, args, {
        out: (s: string) => console.log(s),
        err: (s: string) => console.error(yellow(s)),
        note: (s: string) => console.error(s),
        projectDir: projectDirFor(configPath),
      })
    }
    loadEnvFiles(configPath)
    if (area === 'run') {
      const { cloudRunCommand } = await import('./cloud-run.ts')
      return cloudRunCommand(args, { out: (s) => console.log(s) })
    }
    const cloud = await import('./cloud-secrets.ts')
    const { projectDirFor } = await import('./cloud-project.ts')
    const io = {
      out: (s: string) => console.log(s),
      readValue: cloud.readSecretValue,
      projectDir: projectDirFor(configPath),
    }
    if (area === 'secrets') return cloud.secretsCommand(values, args, io)
    return area === 'gateway'
      ? cloud.gatewayCommand(values, args, io)
      : cloud.providerCommand(values, args, io)
  }
  if (command === 'image') {
    if (filters[0] === 'list') return imageListCommand(values, configPath, filters.slice(1))
    if (filters[0] === 'clean') return imageCleanCommand(values, configPath)
    if (filters[0] !== 'build') {
      throw new UsageError(
        `Unknown command "image ${filters[0] ?? ''}". Did you mean reeval image build, list or clean?`,
      )
    }
    return imageBuildCommand(values, configPath, filters.slice(1))
  }
  if (command === 'studio' && filters[0] === 'share') {
    // Revoking, or listing without a run name to resolve, reads no runs, so it pulls no store.
    const ref = filters[1]
    const readsNoRuns =
      values.revoke !== undefined || (values.list && (ref === undefined || RUN_ID.test(ref)))
    const config = await historyConfig(
      configPath,
      'studio share',
      values.profile,
      readsNoRuns ? { ...values, offline: true } : values,
    )
    const [{ shareCommand }, { projectDirFor }] = await Promise.all([
      import('./studio-share.ts'),
      import('./cloud-project.ts'),
    ])
    return shareCommand(config, values, filters.slice(1), {
      out: (s: string) => console.log(s),
      err: (s: string) => console.error(yellow(s)),
      note: (s: string) => console.error(s),
      projectDir: projectDirFor(configPath),
    })
  }
  if (command === 'studio') {
    const config = await historyConfig(configPath, 'studio', values.profile)
    localStudio(config)
    const { studioCommand } = await import('./studio/command.ts')
    return studioCommand({ config, flags: values, version, run: filters[0] })
  }
  if (command === 'mcp') {
    // On stdio, stdout carries the protocol: anything the config prints goes to stderr.
    if (!values.http) console.log = console.info = console.debug = console.error
    const config = await historyConfig(configPath, 'mcp', values.profile, values)
    const { mcpCommand } = await import('./mcp/command.ts')
    return mcpCommand({ config, flags: values, version })
  }
  if (command in HISTORY_COMMANDS) {
    const config = await historyConfig(configPath, command, values.profile, values)
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
      case 'sync':
        return commands.syncCommand(ctx, filters)
      case 'query': {
        const { queryCommand } = await import('./query.ts')
        return queryCommand({ ...ctx, err: (s: string) => console.error(dim(s)) }, filters)
      }
      case 'analyze': {
        const { analyzeCommand } = await import('./analysis/command.ts')
        return analyzeCommand({ ...ctx, err: (s: string) => console.error(dim(s)) }, filters)
      }
    }
  }
  if (command === 'clean') return cleanCommand(values, configPath)
  if (command === 'attach') return attachCommand(values, filters[0], configPath)
  if (command === 'bundle') {
    const { bundleCommand } = await import('./bundle/index.ts')
    return bundleCommand(values, filters, configPath, argv.slice(1), (s) => console.log(s))
  }
  if (command !== 'run') throw new UsageError(`Unknown command "${command}". Run reeval --help.`)
  if (values.bundle !== undefined) return bundleRun(values, filters)
  return runCommand(values, configPath, filters)
}

/**
 * `reeval run --bundle`: the bundle's own filters, profile, tags, traits and runs, from the
 * project it extracts to. Other run flags (`--json`, `--record`, `--concurrency`, …) apply as given.
 * With `--resume <id>`, the run's state moves from the current directory's `.reeval/` into the
 * extracted project's, and the run continues there.
 */
async function bundleRun(flags: Flags, filters: string[]): Promise<number> {
  const planning = (['profile', 'tag', 'trait', 'runs', 'config', 'retry-errors', 'cloud'] as const)
    .filter((f) => flags[f] !== undefined)
    .map((f) => `--${f}`)
  if (filters.length || planning.length) {
    throw new UsageError(
      `--bundle runs the bundle with the filters, profile, tags, traits and runs it was made with: leave out ${[...(filters.length ? ['filters'] : []), ...planning].join(', ')}.`,
    )
  }
  const file = flags.bundle as string
  const log = (s: string) => (flags.json ? console.error(s) : console.log(s))
  const { bundledGit, checkResumeState, moveResumeState, openBundle } = await import(
    './bundle/index.ts'
  )
  const from = process.cwd()
  const resume = flags.resume
  if (resume !== undefined) checkResumeState(from, resume)
  const opened = await openBundle(file, log)
  if (opened.exit !== undefined) return opened.exit
  const { args, author } = opened.manifest
  if (resume !== undefined) {
    moveResumeState(from, opened.project, resume)
    log(
      `reeval: resuming run ${resume} from ${file} in ${opened.project}, where its .reeval/ stays`,
    )
  } else log(`reeval: running ${file} in ${opened.project}, where its .reeval/ stays`)
  process.chdir(opened.project)
  return runCommand(
    {
      ...flags,
      ...(flags['events-file'] === undefined
        ? {}
        : { 'events-file': resolve(from, flags['events-file']) }),
      bundle: undefined,
      local: true,
      ...(args.profile ? { profile: args.profile } : {}),
      tag: args.tags,
      trait: args.traits,
      ...(args.runs ? { runs: args.runs } : {}),
    },
    opened.config,
    args.filters,
    { git: bundledGit(opened.manifest), ...(author ? { author } : {}) },
  )
}

/**
 * The config a command that reads the history runs on: the profile `--profile`, `REEVAL_PROFILE`
 * or `defaultProfile` picks sets which store it reads, as it does for `reeval run`. `.env` and
 * `.env.local` load first, as for `reeval run`: they can hold the store's keys and the profile.
 */
async function historyConfig(
  configPath: string | undefined,
  command: string,
  flag: string | undefined,
  values: Flags = {},
): Promise<ResolvedConfig> {
  loadEnvFiles(configPath)
  const named = flag ?? (process.env.REEVAL_PROFILE || undefined)
  const loaded = await loadConfig(configPath, command, named)
  const config = withProfileHistory(loaded, selectProfile(loaded, flag))
  if (!config.history.scope) return config
  const history = values['all-branches']
    ? { ...config.history, scope: 'all' as const }
    : config.history
  if (isRemote(history) && command in PULLS && !values.offline) {
    const { cachedAt, unreachable } = await pullStore(history)
    if (unreachable) {
      console.error(
        yellow(
          `${history.store.name} is unreachable (${unreachable}); showing the runs pulled at ${cachedAt}`,
        ),
      )
    }
  }
  return { ...config, history }
}

/** The dry run's prices, fetched only when a planned attempt or the judge has anything to price. */
async function dryRunPrices(planned: PlannedItem[], judgeModel: string | null) {
  const { needsPrices } = await import('./cost.ts')
  const harnesses = planned.filter((p) => !p.attempt.plan.skip).map((p) => p.attempt.harness)
  if (!needsPrices(harnesses, judgeModel)) return { table: null, why: 'nothing to price' }
  const { loadPrices } = await import('./prices.ts')
  return loadPrices()
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

/**
 * `reeval clean`: removes local debug data and snapshots, all of them or all but the newest
 * `--keep` runs', and the sandboxes a killed reeval on this host left running; with `--staging`
 * every stopped run's staging, and with `--bundles` every copy `run --bundle` extracted whose
 * process has ended.
 */
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
      ? `Removed debug data and snapshots for ${runs.length} run${runs.length === 1 ? '' : 's'} (${formatBytes(bytes)}) from ${where} and .reeval/runs`
      : `No debug data or snapshots to remove in ${where} or .reeval/runs`,
  )
  if (flags.staging) {
    const removed = await removeStoppedStaging(config.root)
    console.log(
      removed.length
        ? `Removed the staging of ${removed.length} stopped run${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}`
        : 'No stopped runs in .reeval/staging to remove',
    )
  }
  const streams = await pruneEvents(config.root, keep)
  if (streams.length) {
    console.log(
      `Removed the event streams of ${streams.length} finished run${streams.length === 1 ? '' : 's'} from .reeval/events`,
    )
  }
  const orphans = await removeOrphans()
  if (orphans) {
    console.log(
      `Removed ${orphans} sandbox${orphans === 1 ? '' : 'es'} that a killed reeval left running`,
    )
  }
  if (flags.bundles) {
    const { removeExtractedBundles } = await import('./bundle/index.ts')
    const removed = await removeExtractedBundles()
    console.log(
      removed.length
        ? `Removed ${removed.length} extracted bundle${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}`
        : 'No extracted bundles to remove',
    )
  }
  if (flags.images) {
    const { dockerAvailable, pruneImages } = await import('@reeval/sandbox-docker')
    const { requireDocker } = await import('./sandbox/providers.ts')
    // Docker's images and Podman's are separate stores: prune each one that answers.
    const engines: Array<'docker' | 'podman'> = []
    for (const engine of ['docker', 'podman'] as const) {
      if (await dockerAvailable(engine)) engines.push(engine)
    }
    const { tartCli } = await import('./sandbox/tart-cli.ts')
    const tart = await tartCli(['--version']).then(
      (r) => r.exitCode === 0,
      () => false,
    )
    if (!engines.length && !tart) await requireDocker()
    let removed = 0
    for (const engine of engines) removed += await pruneImages(engine)
    if (engines.length) {
      console.log(
        removed
          ? `Removed ${removed} image${removed === 1 ? '' : 's'} reeval built that nothing uses`
          : 'No leftover images to remove',
      )
    }
    if (tart) {
      const { deleteBakedImages } = await import('./sandbox/tart-bake.ts')
      const baked = await deleteBakedImages()
      console.log(
        baked.length
          ? `Deleted ${baked.length} Tart image${baked.length === 1 ? '' : 's'} with a harness baked in (reeval image build bakes them again): ${baked.join(', ')}`
          : 'No Tart images with a harness baked in to delete',
      )
    }
  }
  return EXIT.ok
}

type QuestionRunner = ReturnType<typeof questionRunner>

/** `-v` is 1 and `-vv` is 2. */
function verbosityOf(flags: Flags): 0 | 1 | 2 {
  return Math.min(2, flags.verbose?.length ?? 0) as 0 | 1 | 2
}

/**
 * `reeval image build`: collects the evals (as `--dry-run` does), pulls every image their `tart()`
 * sandboxes clone that Tart doesn't have, and builds every image their Docker sandboxes need; with
 * `--dry-run`, lists them instead. A plan with no Docker sandbox never runs Docker. `--profile`
 * plans as `reeval run --profile` does. Needs a config, as `reeval run` does: there is no default
 * image.
 */
async function imageBuildCommand(
  flags: Flags,
  configPath: string | undefined,
  filters: string[],
): Promise<number> {
  const {
    buildImages,
    imagePlanLines,
    imageTargets,
    plannedImageUses,
    pullTartImages,
    tartPlanLines,
    tartTargets,
  } = await import('./sandbox/images.ts')
  const { buildVmImages, vmImageTargets, vmPlanLines } = await import('./sandbox/vm-images.ts')
  const { setup, root, uses } = await imageUses(flags, configPath, filters, plannedImageUses)
  const targets = imageTargets(uses)
  const vms = tartTargets(uses)
  const snapshots = vmImageTargets(uses)
  if (targets.length === 0 && vms.length === 0 && snapshots.length === 0) {
    console.log(
      'No eval runs in a Docker or Tart sandbox, or a boat() or daytona() sandbox with an image recipe, so there are no images to build or pull.',
    )
    return EXIT.ok
  }
  const { tartTagWarning } = await import('./sandbox/tart-ref.ts')
  for (const image of new Set(vms.map((t) => t.sandbox.image))) {
    const warning = tartTagWarning(image)
    if (warning) console.log(yellow(`warning: ${warning}`))
  }
  if (flags['dry-run']) {
    if (vms.length) for (const line of await tartPlanLines(vms)) console.log(line)
    if (targets.length) for (const line of await imagePlanLines(targets, root)) console.log(line)
    if (snapshots.length) for (const line of await vmPlanLines(snapshots, root)) console.log(line)
    return EXIT.ok
  }
  const { PrepareError } = await import('./sandbox/provider.ts')
  type Outcome =
    | { id: string; evals: number; ok: true; ref: string; id12: string }
    | {
        id: string
        evals: number
        ok: false
        failure: import('./sandbox/provider.ts').PrepareFailure
      }
  const outcomes: Outcome[] = []
  // In a mixed plan, one kind's check refusing (the host, the engine, the images, the disk) is
  // that kind's failed outcome, so the other kind's still run and print. A refused check that's
  // the config's makes the exit 2 whatever else failed.
  let refused = false
  const refusal = (id: string, of: { evals: number }[], others: number) => (error: unknown) => {
    if (!others || !(error instanceof PrepareError)) throw error
    if (error.failure.usage) refused = true
    const evals = of.reduce((n, t) => n + t.evals, 0)
    outcomes.push({ id, evals, ok: false, failure: error.failure })
    return []
  }
  try {
    const pulled = vms.length
      ? await pullTartImages(vms, root, {
          log: (line) => console.log(line.startsWith('warning: ') ? yellow(line) : dim(line)),
          force: !!flags.force,
        }).catch(refusal('tart', vms, targets.length + snapshots.length))
      : []
    for (const p of pulled) {
      outcomes.push(
        p.ok
          ? {
              id: p.id,
              evals: p.evals,
              ok: true,
              ref: p.image.ref,
              id12: p.image.digest ? short12(p.image.digest) : 'local VM',
            }
          : { id: p.id, evals: p.evals, ok: false, failure: p.failure },
      )
    }
    if (targets.length) {
      const built = await buildImages(targets, root, {
        log: (line) => console.log(dim(line)),
        force: !!flags.force,
        registry: setup.registry,
        push: !!flags.push,
      }).catch(refusal('docker', targets, vms.length + snapshots.length))
      for (const b of built) {
        outcomes.push(
          b.ok
            ? { id: b.id, evals: b.evals, ok: true, ref: b.image.ref, id12: short12(b.image.id) }
            : { id: b.id, evals: b.evals, ok: false, failure: b.failure },
        )
      }
    }
    if (snapshots.length) {
      const built = await buildVmImages(snapshots, root, {
        log: (line) => console.log(dim(line)),
      }).catch(
        refusal(
          'vm',
          snapshots.map((t) => ({ evals: t.ids.length })),
          targets.length + vms.length,
        ),
      )
      for (const b of built) {
        const evals = b.ids.length
        outcomes.push(
          b.ok
            ? {
                id: b.id,
                evals,
                ok: true,
                ref: `snapshot ${b.name}`,
                id12: b.cached ? 'saved' : `built in ${formatDuration(b.ms)}`,
              }
            : { id: b.id, evals, ok: false, failure: b.failure },
        )
      }
    }
  } catch (error) {
    if (!(error instanceof PrepareError)) throw error
    if (error.failure.usage) throw new UsageError(error.message)
    if (error.failure.cause === 'enospc') invocation.machineState = true
    const { PreflightInfraError } = await import('./preflight.ts')
    throw new PreflightInfraError(error.message)
  }
  // Every image, failed or not, so one broken image doesn't hide the state of the others.
  for (const o of outcomes) {
    if (o.ok) {
      console.log(`${green('✓')} ${green(`${o.id}: ${o.ref}`)}${dim(` ${o.id12}`)}`)
      continue
    }
    const uses = o.evals ? ` (${o.evals} eval${o.evals === 1 ? '' : 's'})` : ''
    const [headline = '', ...rest] = o.failure.message.split('\n')
    console.log(`${red('✗')} ${red(`${o.id}${uses}: ${headline}`)}`)
    for (const line of rest) console.log(`  ${line}`)
  }
  const failed = outcomes.filter((o) => !o.ok)
  const n = outcomes.length
  console.log(
    failed.length
      ? red(
          `${failed.length} of ${n} image${n === 1 ? '' : 's'} failed to ${vms.length ? (targets.length || snapshots.length ? 'build or pull' : 'pull') : 'build'}`,
        )
      : dim(`${n} image${n === 1 ? '' : 's'} ready`),
  )
  if (!failed.length) return EXIT.ok
  // A missing docker({ image }) is fixed in the config; anything else is the build's.
  if (refused || failed.every((o) => !o.ok && o.failure.usage)) return EXIT.usage
  invocation.machineState = failed.every((o) => !o.ok && o.failure.cause === 'enospc')
  return EXIT.infra
}

/** What `reeval image` plans for: the harness and sandbox of each attempt, collected as `--dry-run` does. */
async function imageUses(
  flags: Flags,
  configPath: string | undefined,
  filters: string[],
  planned?: typeof import('./sandbox/images.ts').plannedImageUses,
) {
  const plannedImageUses = planned ?? (await import('./sandbox/images.ts')).plannedImageUses
  const setup = await prepareRun({ ...flags, 'dry-run': true }, configPath)
  const ctx = await startRun(setup)
  const { runId, stagingDir, config, runs, tags, concurrency, profile } = ctx
  const uses = await plannedImageUses(
    { runId, stagingDir, config, runs, tags, concurrency, profile },
    filters,
    (parts) => unmatchedFilter(config, parts),
  )
  return { setup, root: config.root, uses }
}

/**
 * `reeval image list`: the image snapshots under each `boat()` and `daytona()` account and prefix
 * the evals use, with the environments that start from each.
 */
async function imageListCommand(
  flags: Flags,
  configPath: string | undefined,
  filters: string[],
): Promise<number> {
  const vm = await import('./sandbox/vm-images.ts')
  const { formatSize } = await import('./sandbox/tart-images.ts')
  const { root, uses } = await imageUses(flags, configPath, filters)
  const accounts = vm.vmAccounts(uses)
  if (!accounts.length) {
    console.log(
      'No eval runs in a boat() or daytona() sandbox, so there are no image snapshots to list.',
    )
    return EXIT.ok
  }
  const [{ snapshots, failed }, { usedBy }] = await Promise.all([
    vm.listAccounts(accounts, root),
    vm.usedSnapshots(vm.vmImageTargets(uses), root),
  ])
  const cache = vm.readVmImageCache()
  const rows = snapshots.map((s) => ({
    ...s,
    lastUsedAt: vm.lastUsed(s, cache),
    usedBy: usedBy.get(s.name) ?? [],
  }))
  if (flags.json) {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())
    console.log(
      JSON.stringify(
        {
          snapshots: rows.map((r) => ({
            ...r,
            createdAt: iso(r.createdAt),
            lastUsedAt: iso(r.lastUsedAt),
          })),
          failed: failed.map((f) => ({
            provider: f.account.provider,
            account: f.account.sandbox.apiKey.from,
            prefix: f.account.sandbox.prefix,
            error: f.error.message,
          })),
        },
        null,
        2,
      ),
    )
    return failed.length ? EXIT.infra : EXIT.ok
  }
  const table = rows.map((r) => [
    r.provider,
    r.name,
    r.status,
    r.sizeBytes === null ? '-' : formatSize(r.sizeBytes),
    `saved ${vm.ago(r.createdAt)}`,
    `used ${vm.ago(r.lastUsedAt)}`,
    r.usedBy.length ? r.usedBy.join(', ') : dim('no environment'),
  ])
  const widths =
    table[0]?.map((_, i) => Math.max(...table.map((row) => (row[i] ?? '').length))) ?? []
  for (const row of table) {
    console.log(
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  '),
    )
  }
  for (const f of failed) console.log(red(`✗ ${vm.accountLabel(f.account)}: ${f.error.message}`))
  const n = rows.length
  console.log(
    dim(`${n} snapshot${n === 1 ? '' : 's'} under ${accounts.map(vm.accountLabel).join(', ')}`),
  )
  return failed.length ? EXIT.infra : EXIT.ok
}

/**
 * `reeval image clean`: deletes the image snapshots no environment of the evals starts from, under
 * each `boat()` and `daytona()` account and prefix they use, never one used in the
 * last hour or one still being saved.
 */
async function imageCleanCommand(flags: Flags, configPath: string | undefined): Promise<number> {
  const vm = await import('./sandbox/vm-images.ts')
  const { formatSize } = await import('./sandbox/tart-images.ts')
  const provider = flags.provider
  if (provider !== undefined && provider !== 'boat' && provider !== 'daytona') {
    throw new UsageError(`--provider is boat or daytona (got "${provider}")`)
  }
  const olderThanMs =
    flags['older-than'] !== undefined
      ? vm.parseAge(flags['older-than'])
      : flags.all
        ? undefined
        : vm.DEFAULT_OLDER_THAN_MS
  const { root, uses } = await imageUses(flags, configPath, [])
  const accounts = vm.vmAccounts(uses).filter((a) => !provider || a.provider === provider)
  if (!accounts.length) {
    console.log(
      `No eval runs in a ${provider ? `${provider}()` : 'boat() or daytona()'} sandbox, so there are no image snapshots to clean.`,
    )
    return EXIT.ok
  }
  const [{ snapshots, failed }, { usedBy, unknown }] = await Promise.all([
    vm.listAccounts(accounts, root),
    vm.usedSnapshots(
      vm.vmImageTargets(uses).filter((t) => !provider || t.provider === provider),
      root,
    ),
  ])
  const refused = unknown.find((u) => (u.error as { failure?: { usage?: boolean } }).failure?.usage)
  if (refused) throw new UsageError(refused.error.message)
  if (unknown.length && !flags.all) {
    for (const u of unknown) {
      console.log(
        red(
          `✗ couldn't tell which snapshot ${u.target.id} starts from: ${u.error.message.split('\n')[0]}`,
        ),
      )
    }
    console.log(red("Nothing was deleted, so a snapshot in use isn't. Fix that, or pass --all."))
    return EXIT.infra
  }
  const choices = vm.cleanChoices(snapshots, {
    cache: vm.readVmImageCache(),
    usedBy,
    now: Date.now(),
    ...(olderThanMs !== undefined && { olderThanMs }),
    all: !!flags.all,
  })
  const doomed = choices.filter((c) => c.keep === null)
  const byAccount = (s: { provider: string; account: string; prefix: string }) =>
    accounts.find(
      (a) =>
        a.provider === s.provider &&
        a.sandbox.apiKey.from === s.account &&
        a.sandbox.prefix === s.prefix,
    ) as import('./sandbox/vm-images.ts').VmAccount
  let freed = 0
  let deleted = 0
  let failures = failed.length
  for (const c of choices) {
    const size = c.snapshot.sizeBytes === null ? '' : ` (${formatSize(c.snapshot.sizeBytes)})`
    if (c.keep !== null) {
      console.log(dim(`  kept ${c.snapshot.provider} ${c.snapshot.name}: ${c.keep}`))
      continue
    }
    if (flags['dry-run']) {
      console.log(`  would delete ${c.snapshot.provider} ${c.snapshot.name}${size}`)
      continue
    }
    try {
      await vm.deleteVmSnapshot(byAccount(c.snapshot), c.snapshot, root)
      deleted++
      freed += c.snapshot.sizeBytes ?? 0
      console.log(`${green('✓')} deleted ${c.snapshot.provider} ${c.snapshot.name}${size}`)
    } catch (error) {
      failures++
      console.log(red(`✗ ${c.snapshot.provider} ${c.snapshot.name}: ${(error as Error).message}`))
    }
  }
  for (const f of failed) console.log(red(`✗ ${vm.accountLabel(f.account)}: ${f.error.message}`))
  const n = doomed.length
  console.log(
    dim(
      flags['dry-run']
        ? `${n} snapshot${n === 1 ? '' : 's'} to delete (nothing deleted: --dry-run)`
        : `Deleted ${deleted} snapshot${deleted === 1 ? '' : 's'}${freed ? ` (${formatSize(freed)})` : ''}`,
    ),
  )
  return failures ? EXIT.infra : EXIT.ok
}

/** The first 12 hex digits of an image id or digest. */
const short12 = (id: string) => id.replace(/^sha256:/, '').slice(0, 12)

/**
 * `reeval attach`: a run's socket URL or stream file as given, else the run a ref names (by default the one in
 * progress) and the stream file it writes. Exits with the run's exit code.
 */
async function attachCommand(
  flags: Flags,
  target: string | undefined,
  configPath: string | undefined,
): Promise<number> {
  let source: string
  // Where the run's live.json is, which is what lets x cancel it: a stream in a project's
  // `.reeval/events/` is that project's run, any other this project's when there is one.
  let root = configPath === undefined ? undefined : dirname(configPath)
  if (target && (isAttachUrl(target) || existsSync(target))) {
    source = target
    const inEvents = isAttachUrl(target)
      ? null
      : /^(.*)[\\/]\.reeval[\\/]events[\\/][^\\/]+\.ndjson$/.exec(resolve(target))
    if (inEvents?.[1]) root = inEvents[1]
  } else {
    root = dirname(requireConfig(configPath))
    source = (await resolveAttach(root, target)).file
  }
  const cloud = await import('./cloud-run.ts')
  if (flags.profile !== undefined && !flags.download) {
    throw new UsageError(
      '--profile picks the history folder --download puts a recorded cloud run in: pass it with --download',
    )
  }
  // The platform URL may be in the project's .env, as it is for the other cloud commands.
  if (flags.download || isAttachUrl(source)) loadEnvFiles(configPath)
  const download = flags.download
    ? await cloudDownload(source, configPath, flags.profile)
    : undefined
  const follow = isAttachUrl(source) ? await cloud.cloudFollow(source) : undefined
  const cloudRun = follow ? await cloudRunAt(source) : null
  let detached = false
  let code: number
  let read: Awaited<ReturnType<typeof cloud.afterLostStream>>['read'] | undefined
  const log = (line: string) => console.log(dim(line))
  try {
    code = await attachHere(flags, {
      source,
      ...(root === undefined ? {} : { root }),
      ...(follow ? { follow } : {}),
      ...(cloudRun ? { cancelHint: cloud.cancelHint(cloudRun.runId) } : {}),
      onDetach: () => {
        detached = true
      },
    })
  } catch (error) {
    const { EventStreamError } = await import('./events.ts')
    if (!cloudRun || !(error instanceof EventStreamError)) throw error
    ;({ code, read } = await cloud.afterLostStream(
      error,
      cloudRun.runId,
      cloudRun.base,
      cloudRun.auth,
      log,
    ))
  }
  if (cloudRun && !detached) {
    code = await cloud.stoppedOr(code, cloudRun.runId, cloudRun.base, cloudRun.auth, log, read)
  }
  if (download && detached) {
    console.log(
      dim(
        `Not downloading the files of cloud run ${download.runId} after detaching: reeval attach --download${download.profile === undefined ? '' : ` --profile ${download.profile}`} ${displayUrl(source)} downloads them once it has ended`,
      ),
    )
  } else if (download) {
    const { downloadAfter } = await import('./cloud-files.ts')
    for (const line of await downloadAfter(code, download.runId, download.run)) {
      console.log(dim(line))
    }
  }
  return code
}

/** The cloud run whose event stream is `source`, with what reads it; null for any other stream. */
async function cloudRunAt(source: string) {
  const cloud = await import('./cloud-run.ts')
  const { cloudRunOf } = await import('./cloud-files.ts')
  const base = cloud.cloudUrl()
  const run = cloudRunOf(source, base)
  return run ? { runId: run.runId, base, auth: await cloud.cloudAuth(base) } : null
}

/**
 * `reeval attach --download`: what downloads the files of the cloud run whose event stream is
 * `source` into this project, as a run here leaves them, a recorded run's into the history folder
 * of the profile `profile`, `REEVAL_PROFILE` or `defaultProfile` picks; exit 2 for any other
 * stream, or with no project.
 */
async function cloudDownload(
  source: string,
  configPath: string | undefined,
  profile: string | undefined,
) {
  const cloud = await import('./cloud-run.ts')
  const { cloudRunOf, downloadCloudFiles } = await import('./cloud-files.ts')
  // The platform URL may be in the project's .env, as it is for the other cloud commands.
  loadEnvFiles(configPath)
  const base = cloud.cloudUrl()
  const run = isAttachUrl(source) ? cloudRunOf(source, base) : null
  if (!run) {
    throw new UsageError(
      `--download takes a cloud run's event stream URL (${base.href}api/runs/<run>/events), not ${displayUrl(source)}: a run on this machine has its files in .reeval/ already`,
    )
  }
  const path = requireConfig(configPath)
  const named = profile ?? (process.env.REEVAL_PROFILE || undefined)
  const loaded = await loadConfig(path, 'run', named)
  const picked = selectProfile(loaded, profile)
  const { root, history } = withProfileHistory(loaded, picked)
  const auth = await cloud.cloudAuth(base)
  return {
    runId: run.runId,
    ...(picked ? { profile: picked.name } : {}),
    run: () => downloadCloudFiles({ cloudRunId: run.runId, url: run.files, auth, root, history }),
  }
}

/** `reeval attach`'s viewer on this terminal, drawn with the attach flags. */
async function attachHere(
  flags: Flags,
  options: Pick<
    import('./attach.ts').AttachOptions,
    'source' | 'root' | 'follow' | 'onDetach' | 'cancelHint' | 'resumedAfter'
  >,
): Promise<number> {
  const { attach } = await import('./attach.ts')
  return attach({
    ...options,
    out: process.stdout,
    columns: process.stdout.columns,
    colorDepth: process.stdout.isTTY ? process.stdout.getColorDepth() : undefined,
    tty: { stdout: process.stdout, stdin: process.stdin },
    output: (verbosity) =>
      resolveOutput({
        flags: {
          ui: flags.ui,
          logOrder: flags['log-order'],
          logPrefix: flags['log-prefix'],
          outputLogs: flags['output-logs'],
          verbose: verbosity > 0,
        },
        env: process.env,
        isTTY: !!process.stdout.isTTY,
        agent: detectAgent().name,
        stdinTTY: !!process.stdin.isTTY,
      }),
  })
}

/**
 * Where a run that asked for the cloud platform goes, from the bundle made for it: there, or
 * here with why. A real run there is created, uploaded, started and followed, and its exit code is
 * `exit`. Undefined when the run didn't ask to run in the cloud.
 */
async function cloudTarget(
  flags: Flags,
  setup: Awaited<ReturnType<typeof prepareRun>>,
  filters: string[],
  configPath: string | undefined,
): Promise<{ exit: number } | { target: RunTarget; detail: string } | undefined> {
  const cloud = await import('./cloud-run.ts')
  if (!cloud.wantsCloud(flags, setup.config, setup.profile)) {
    if (flags.download) {
      throw new UsageError(
        "--download downloads a cloud run's files, and this run is on this machine: its files are in .reeval/ already. Leave it out, or pass --cloud",
      )
    }
    return undefined
  }
  const { linkedProject, projectDirFor } = await import('./cloud-project.ts')
  const project = await linkedProject(projectDirFor(configPath))
  if (!project) {
    throw new UsageError(
      `A cloud run goes into a linked cloud project, and this project isn't linked: run ${process.stdin.isTTY ? 'reeval link' : 'reeval link --org <org> --project <project>'} to link it, or pass --local to run here`,
    )
  }
  const { makeBundle } = await import('./bundle/index.ts')
  // The profile this machine picked (from REEVAL_PROFILE or defaultProfile too) goes in the
  // bundle's arguments, so the platform's machine plans with the same one.
  const picked = setup.profile ? { profile: setup.profile.name } : {}
  type Made =
    | { code: number }
    | { why: string }
    | { made: Exclude<Awaited<ReturnType<typeof makeBundle>>, { code: number }> }
  const bundle = async (env: Record<string, string>): Promise<Made> => {
    try {
      const made = await makeBundle(
        { ...flags, ...picked },
        filters,
        configPath,
        process.argv.slice(2),
        { env, prices: true, cloud: true },
      )
      if ('code' in made) return made
      const blocked = made.plan.notCloud ?? []
      return blocked.length ? { why: blocked.join('; ') } : { made }
    } catch (error) {
      if (!(error instanceof UsageError)) throw error
      return { why: error.message }
    }
  }
  let result = await bundle({})
  let base: URL | null = null
  if ('made' in result) {
    cloud.refuseLocalFlags(flags)
    const url = cloud.cloudUrl()
    if (!setup.dryRun) {
      base = url
      const env = await cloud.cloudPlanEnv(base)
      const differs = Object.entries(env).some(([k, v]) => process.env[k] !== v)
      if (differs) result = await bundle(env)
    }
  }
  if ('code' in result) return { exit: result.code }
  if ('why' in result) {
    const why = result.why.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())
    if (!setup.dryRun) {
      console.log(dim(`Running here, not in the cloud: ${why}`))
      if (setup.recording) storeCredentials(setup.config.history)
    }
    return {
      target: { kind: 'local', why },
      detail: `target  here, not in the cloud: ${why.split('\n')[0]}`,
    }
  }
  const { made } = result
  if (!base) {
    const line = await cloud.cloudLine(made.plan, 'target  cloud')
    return { target: { kind: 'cloud' }, detail: line }
  }
  console.log(await cloud.cloudLine(made.plan))
  if (setup.recording) {
    console.log(dim("record: a cloud run isn't recorded into this machine's history"))
  }
  const exit = await cloud.runCloud({
    base,
    bundle: made,
    project,
    log: (line) => console.log(dim(line)),
    ...(process.stdin.isTTY && process.stdout.isTTY && { confirm }),
    ...(flags.force && { force: true }),
    follow: (options) => attachHere(flags, options),
    ...(flags.download && {
      download: {
        root: setup.config.root,
        history: setup.config.history,
        ...(setup.profile ? { profile: setup.profile.name } : {}),
      },
    }),
  })
  return { exit }
}

/** `reeval run`: check, plan, run the engine, then write the run and pick the exit code. */
async function runCommand(
  flags: Flags,
  configPath: string | undefined,
  given: string[],
  bundled?: Bundled,
): Promise<number> {
  const retry = flags['retry-errors']
  const url = flags['events-url']
  const parsed = url === undefined ? null : URL.parse(url)
  if (url !== undefined && !(parsed && isEventsUrl(url))) {
    throw new UsageError(`--events-url takes an http or https URL (got ${stripCredentials(url)})`)
  }
  if (url !== undefined && (parsed?.username || parsed?.password)) {
    throw new UsageError(
      `--events-url can't carry a user name or password (got ${stripCredentials(url)}): put a token in the path or query instead`,
    )
  }
  const eventsFileFlag = flags['events-file']
  if (eventsFileFlag !== undefined) {
    const refused = notEventStream(resolve(eventsFileFlag))
    if (refused) throw new UsageError(`--events-file: ${refused}`)
  }
  if (retry !== undefined && flags.resume !== undefined) {
    throw new UsageError('--resume and --retry-errors both continue a run: pass one of them.')
  }
  if (flags.cloud && flags.local) wantsCloud(flags, { cloud: false }, null)
  const continued = flags.resume !== undefined || retry !== undefined
  if (continued && flags.cloud) return cloudContinue(flags, given, configPath)
  if (retry !== undefined && (given.length || flags.tag?.length || flags.trait?.length)) {
    throw new UsageError(
      '--retry-errors runs every infra-errored attempt of the run again, with its plan: leave out filters, --tag and --trait.',
    )
  }
  const resumed = continued ? await resumedRun(flags, given, configPath, bundled) : null
  if (resumed?.cloud) return cloudContinue(flags, given, configPath, resumed.cloud)
  if (resumed?.nothing) {
    // Nothing runs, so the exit code and `--json` are the run's own, as it was recorded.
    const { nothing, record } = resumed.nothing
    const outcome = runOutcome(record)
    if (flags.json) {
      console.error(nothing)
      const { suiteResult } = await import('./view/suite.ts')
      process.stdout.write(`${JSON.stringify({ ...suiteResult(record), outcome }, null, 2)}\n`)
    } else console.log(nothing)
    return outcome === 'fail' ? EXIT.failed : outcome === 'infra_error' ? EXIT.infra : EXIT.ok
  }
  // A run this machine continues ran here, whatever the config or its profile says now.
  const runFlags = {
    ...flags,
    ...resumed?.settings,
    ...(resumed && { local: true, cloud: undefined }),
  }
  const filters = resumed?.settings?.filters ?? given
  const setup = await prepareRun(runFlags, configPath, {
    noProfile: !!resumed?.saved && resumed.saved.profile === undefined,
    ...(resumed?.profileOf ? { profileOf: resumed.profileOf } : {}),
  })
  if (resumed && !bundled && !flags.local && wantsCloud(flags, setup.config, setup.profile)) {
    console.log(dim(`run ${resumed.runId} ran on this machine, so it continues here`))
  }
  const cloud = bundled ? undefined : await cloudTarget(runFlags, setup, filters, configPath)
  if (cloud && 'exit' in cloud) return cloud.exit
  const explicit = runFlags.concurrency ?? (process.env.REEVAL_CONCURRENCY || undefined)
  const ctx = await startRun(setup, bundled)
  const startedWith: RunInvocation | undefined = resumed
    ? (resumed.saved ?? undefined)
    : {
        ...(setup.runs === undefined ? {} : { runs: setup.runs }),
        ...(setup.profile ? { profile: setup.profile.name } : {}),
        ...(explicit === undefined ? {} : { concurrency: ctx.concurrency }),
        filters: savedFilters(setup.config.root, filters),
        tags: runFlags.tag ?? [],
        ...(runFlags.trait?.length ? { traits: runFlags.trait } : {}),
      }
  invocation.runId = ctx.runId
  const githubOut = process.env.GITHUB_OUTPUT
  if (githubOut) await appendFile(githubOut, `run-id=${ctx.runId}\n`).catch(() => {})
  const stepStart = process.env.GITHUB_STEP_SUMMARY
  if (stepStart) await appendFile(stepStart, `run ${ctx.runId}\n`).catch(() => {})
  const { engineVersions } = await import('./engine/node.ts')
  // The JSON plan is the only output of `--dry-run --json`; a run's JSON is the only stdout of
  // `--json`, so its progress goes to stderr.
  const terminal = setup.json && !setup.dryRun ? process.stderr : process.stdout
  const harness = setup.config.harness[0]?.kind ?? 'agent'
  const drawn = createRenderer({
    out: setup.json && setup.dryRun ? { write: () => true } : terminal,
    columns: terminal.columns,
    colorDepth: terminal.isTTY ? terminal.getColorDepth() : undefined,
    output: setup.output,
    verbosity: ctx.verbosity ?? 0,
    harness,
    tty: { stdout: process.stdout, stdin: process.stdin },
  })
  const root = setup.config.root
  const eventsTo =
    eventsFileFlag !== undefined
      ? resolve(eventsFileFlag)
      : flags.events
        ? eventsFile(root, ctx.runId)
        : resumed?.saved?.events
          ? resolve(root, resumed.saved.events)
          : undefined
  const savedEvents = eventsTo ? relativeFile(root, eventsTo) : undefined
  if (startedWith && savedEvents) startedWith.events = savedEvents
  const eventsUrl = flags['events-url']
  let heartbeat: AttemptsBeat | undefined
  if (eventsTo || eventsUrl) {
    const ms = parseHeartbeat(
      'REEVAL_EVENTS_HEARTBEAT',
      process.env.REEVAL_EVENTS_HEARTBEAT,
      ATTEMPTS_HEARTBEAT_MS,
      ATTEMPTS_HEARTBEAT_RANGE,
    )
    const cwd = cwdIn(root)
    eventStream = openEventStream({
      ...(eventsTo ? { file: eventsTo, append: continued } : {}),
      ...(eventsUrl ? { url: eventsUrl } : {}),
      header: {
        reeval: version,
        runId: ctx.runId,
        startedAt: new Date().toISOString(),
        harness,
        verbosity: ctx.verbosity ?? 0,
        ...(cwd === undefined ? {} : { cwd }),
        ...(ms > 0 ? { attemptsHeartbeatMs: ms } : {}),
      },
      warn: (message) => process.stderr.write(yellow(`reeval: ${message}\n`)),
    })
    const stream = eventStream
    if (ms > 0) heartbeat = { ms, send: (beat) => stream.heartbeat(beat) }
  }
  const renderer = eventStream ? teeRenderer(drawn, eventStream) : drawn
  let executed: Awaited<ReturnType<typeof executeRun>>
  try {
    executed = await executeRun(ctx, setup, filters, renderer, {
      startedWith,
      notes: resumed?.notes ?? [],
      narrowed: !!resumed && (given.length > 0 || !!flags.tag?.length || !!flags.trait?.length),
      ...(savedEvents ? { events: savedEvents } : {}),
      ...(heartbeat ? { heartbeat } : {}),
      ...(cloud ? { target: cloud.target, targetDetail: cloud.detail } : {}),
    })
  } catch (error) {
    renderer.close()
    if (ctx.retry) await undoRetry(setup.config.root, ctx)
    else if (setup.resume === undefined) {
      await rm(ctx.stagingDir, { recursive: true, force: true })
    }
    throw error
  }
  const { engineRun, plan, sandboxVersions, budgetReached, cutShort, live, questions, leftOut } =
    executed
  const exportDone = async () => {
    const why = await executed.exported
    if (why)
      renderer.onEvent({
        type: 'notice',
        at: Date.now(),
        level: 'warn',
        text: `OpenTelemetry export: ${why}`,
      })
  }
  const { retried } = executed
  invocation.unhandledErrors = engineRun.unhandledErrors
  if ((interrupted || engineRun.canceled) && plan) {
    await cleanupRun(ctx.runId, plan.sandboxes)
  }
  // Every worker has exited, so this catches the sandboxes of one that was killed mid-attempt.
  if (plan) await reapOrphans(plan.sandboxes)
  if (engineRun.stopped || !plan) {
    live?.remove()
    await exportDone()
    renderer.close()
    return EXIT.ok
  }
  if (ctx.retry && ctx.previous && retried.size) {
    const { retryEnvironmentChanges } = await import('./retry.ts')
    const changes = retryEnvironmentChanges(ctx.previous, ctx.stagingDir, retried)
    if (changes.length) {
      questions?.cancel()
      live?.remove()
      renderer.close()
      await undoRetry(setup.config.root, ctx)
      throw new UsageError(
        `run ${ctx.runId}'s plan changed since it ran: ${changes.join('; ')}. ${retryVerb(ctx.retry, ctx.runId)} only with the plan they ran with, so the run is left as it was: put it back, or start a new run with reeval run.`,
      )
    }
  }

  let stopped = cutShort || engineRun.canceled
  // A canceled run keeps the per-attempt answers that came back before it stopped, and asks
  // no pairwise question.
  if (stopped) questions?.cancel()
  let answers = stopped ? await questions?.answered() : await questions?.settle()
  // A signal once the engine has returned aborts the questions' calls (the signal handler
  // cancels them), so a run with questions stops there too.
  if (!stopped && interrupted && questions) {
    stopped = true
    answers = await questions?.answered()
  }
  // In the same tick as the decision above: once live.json reads `finishing`, a signal is no
  // longer a cancel.
  finishing = true
  live?.phase('finishing')
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
      reeval: version,
      runtime: runtimeInfo(),
      language: { name: 'typescript' },
      enginePackages: engineVersions,
      sandbox: sandboxVersions,
      ...(ctx.retry ? { retry: ctx.retry } : {}),
      worktreePatch: ctx.worktreePatch,
      lockfiles: await lockfiles(ctx.config.root),
      git: ctx.git,
      previous: ctx.previous,
      previousArtifacts: ctx.previousArtifacts,
      leftOut,
      runner: runnerInfo(),
      ...(startedWith ? { invocation: startedWith } : {}),
      ...(answers && (answers.evals.size || answers.attempts.size) ? { answers } : {}),
    },
    // Until the record lands, the studio shows the run as live.
    () => live?.stop(),
  )
  const { record } = run
  // The studio and `reeval show` read the same outcome from the record.
  const outcome = runOutcome(record)
  const notRun = leftOut.filter((l) => !l.done).length
  // Left incomplete by its filters, a resume exits on the attempts it ran, and `--json` says so.
  const ran =
    notRun > 0 && !stopped && record.status === 'interrupted'
      ? runOutcome({ ...record, status: 'complete' })
      : outcome
  let code: number = stopped
    ? stopCode
    : ran === 'fail'
      ? EXIT.failed
      : ran === 'infra_error'
        ? EXIT.infra
        : EXIT.ok
  const { pruneDebug } = await import('./debug/files.ts')
  await pruneDebug(ctx.config.root, ctx.config.debug.keep).catch(() => {})
  const summary = run.artifactDir ? join(run.artifactDir, 'summary.md') : run.recordPath

  const { config } = ctx
  const mode = setup.record
  const { readRecord, recordFile } = await import('./history/files.ts')
  // A retry or resume writes its outcomes into the history too, when the run was already recorded
  // there: a resume may finish a retry that was interrupted.
  const rerecord =
    (setup.retry !== undefined || setup.resume !== undefined) &&
    record.status === 'complete' &&
    existsSync(recordFile(config.history.dir, record.runId))
  const autoRecord = flags.record || mode === 'always' || (mode === 'ci' && inCI()) || rerecord
  // A run budget.duration stopped is recorded too, as status `budget`: it's what the budget
  // allowed, and compare never takes an incomplete run as its base. An interrupted one isn't.
  const recording = autoRecord && record.status !== 'interrupted'
  // `run-end` names where the run was recorded, so it waits for the record to land, but not for
  // a remote store's upload: the summary comes first, then the upload's line or error.
  let ended = false
  const endRun = async (recorded?: RecordedPaths) => {
    if (ended) return
    ended = true
    await exportDone()
    renderer.onEvent({
      type: 'run-end',
      at: Date.now(),
      record,
      summaryPath: fromCwd(summary),
      results: engineRun.evals,
      remarks: run.remarks,
      ...(notRun > 0 && !stopped ? { notRun } : {}),
      ...(recorded ? { recorded } : {}),
    })
    renderer.close()
    if (retried.size) {
      const { retryCounts, retryLine } = await import('./retry.ts')
      const line = retryLine(retryCounts(record, retried, ctx.previous))
      if (setup.json) console.error(line)
      else console.log(line)
    }
    const stepSummary = process.env.GITHUB_STEP_SUMMARY
    if (stepSummary && run.artifactDir) {
      await appendFile(stepSummary, await readFile(summary)).catch(() => {})
    }
  }
  let recordLine: string | undefined
  let recordError: unknown
  if (recording) {
    const { record: recordCmd } = await import('./commands.ts')
    const allow = record.status === 'budget' ? { 'allow-incomplete': true } : {}
    try {
      // A re-record keeps the level the run was recorded at, which `reeval record --artifacts`
      // may have set.
      const level = rerecord
        ? { artifacts: (await readRecord(recordFile(config.history.dir, record.runId))).artifacts }
        : {}
      recordLine = await recordCmd(
        config,
        record.runId,
        { ...flags, ...allow, ...level },
        (landed) =>
          endRun({
            record: fromCwd(landed.recordPath),
            files: landed.artifactDir ? fromCwd(landed.artifactDir) : null,
            ...(landed.archive ? { archive: fromCwd(landed.archive.path) } : {}),
          }),
      ).catch((error: Error) => {
        if (error.name !== 'StoreError') throw error
        if (code !== EXIT.interrupted && code !== EXIT.terminated) code = EXIT.infra
        invocation.machineState = true
        return red(`reeval: ${redactSecrets(error.message)}`)
      })
    } catch (error) {
      recordError = error
    }
  }
  await endRun()
  if (recordError !== undefined) throw recordError
  if (recordLine !== undefined) {
    if (setup.json) console.error(recordLine)
    else console.log(recordLine)
  } else if (autoRecord && notRun > 0 && !stopped) {
    const line = `Not recorded: run ${record.runId} is incomplete. reeval run --resume ${record.runId}${flags.record ? ' --record' : ''} runs the rest and records it.`
    if (setup.json) console.error(line)
    else console.log(line)
  }
  if (setup.json) {
    const { suiteResult } = await import('./view/suite.ts')
    process.stdout.write(`${JSON.stringify({ ...suiteResult(record), outcome: ran }, null, 2)}\n`)
  }
  await renderer.wait?.()
  return code
}

/**
 * `reeval run --cloud --resume <run>`, or `--resume` where the config or its profile runs in the
 * cloud and the run is a cloud run's download here or isn't here at all: resumes the cloud run
 * and follows it. Its bundle fixed the filters, runs, tags and traits, so it takes none of them;
 * `--profile` only picks where it goes and the history `--download` files it in. It needs no
 * config: `found` is the config the cloud was picked from and, for a download, its cloud run.
 */
async function cloudContinue(
  flags: Flags,
  filters: string[],
  configPath: string | undefined,
  found?: {
    config: Awaited<ReturnType<typeof loadConfig>>
    origin: Awaited<ReturnType<typeof import('./cloud-files.ts').cloudOriginOf>>
  },
): Promise<number> {
  const cloud = await import('./cloud-run.ts')
  if (flags['retry-errors'] !== undefined) {
    throw new UsageError(
      '--retry-errors runs the infra errors of a run on this machine again, not of a cloud run: reeval run --cloud --resume <run> continues a cloud run, or pass --local to retry a run here',
    )
  }
  const fixed = [
    ...(filters.length ? ['filters'] : []),
    ...(['runs', 'tag', 'trait'] as const)
      .filter((f) => flags[f] !== undefined)
      .map((f) => `--${f}`),
  ]
  if (fixed.length) {
    throw new UsageError(
      `a cloud run resumes with the filters, runs, tags and traits it started with: leave out ${fixed.join(', ')}`,
    )
  }
  cloud.refuseLocalFlags(flags)
  const starting = (['dry-run', 'json', 'force'] as const).filter((f) => flags[f])
  if (starting.length) {
    throw new UsageError(
      `${starting.map((f) => `--${f}`).join(', ')} ${starting.length === 1 ? 'applies' : 'apply'} to starting a cloud run, not resuming one: leave ${starting.length === 1 ? 'it' : 'them'} out`,
    )
  }
  const ref = flags.resume ?? ''
  let origin = found?.origin ?? null
  if (!origin && (!ref || /^latest(~\d+)?$/.test(ref))) {
    throw new UsageError(
      "reeval run --cloud --resume needs the run: pass the cloud run's id, which reeval run --cloud printed, or its event stream URL",
    )
  }
  if (!origin && configPath !== undefined && !isAttachUrl(ref)) {
    const { cloudOriginOf } = await import('./cloud-files.ts')
    origin = await cloudOriginOf(dirname(configPath), ref)
  }
  // The platform URL may be in the project's .env, as it is for the other cloud commands.
  loadEnvFiles(configPath)
  const base = cloud.cloudUrl()
  let download: { root: string; history: ResolvedHistory; profile?: string } | undefined
  if (flags.download || flags.profile !== undefined) {
    if (configPath === undefined) {
      const flag = flags.download ? '--download' : '--profile'
      throw new UsageError(
        `${flag} reads the project's config, and there's no reeval config here: run it in the project, or leave out ${flag}`,
      )
    }
    const config =
      found?.config ??
      (await loadConfig(
        configPath,
        'run',
        flags.profile ?? origin?.profile ?? (process.env.REEVAL_PROFILE || undefined),
      ))
    // The history a downloaded run was filed in is its own profile's, while the config has it.
    const own = origin?.profile && config.profiles[origin.profile] ? origin.profile : undefined
    const picked = selectProfile(config, flags.profile ?? own)
    const { root, history } = withProfileHistory(config, picked)
    if (flags.download) download = { root, history, ...(picked ? { profile: picked.name } : {}) }
  }
  if (origin) console.log(dim(`run ${origin.runId} is cloud run ${origin.cloudRunId}'s download`))
  return cloud.resumeCloud({
    base,
    run: origin?.cloudRunId ?? ref,
    checkout: configPath !== undefined,
    lookedHere: !!found && !origin,
    log: (line) => console.log(dim(line)),
    follow: (options) => attachHere(flags, options),
    ...(download && { download }),
  })
}

/** Puts back a retry that stopped before it changed the run, with its `.reeval/cloud` marker. */
async function undoRetry(root: string, ctx: StartedRun): Promise<void> {
  await restoreRetry(root, ctx.runId)
  if (ctx.forgotOrigin === undefined) return
  const { rememberCloudOrigin } = await import('./cloud-files.ts')
  await rememberCloudOrigin(root, ctx.runId, ctx.forgotOrigin)
}

/**
 * The cloud continuation of run `runId` (its whole id) when it was downloaded from a cloud run and the
 * config or its profile runs in the cloud (`--profile`, else the run's own, else the default's).
 */
async function cloudContinuation(flags: Flags, path: string, runId: string, bundled?: Bundled) {
  if (flags.local || bundled) return null
  const { cloudOriginOf } = await import('./cloud-files.ts')
  const origin = await cloudOriginOf(dirname(path), runId, { exact: true })
  if (!origin) return null
  const named = flags.profile ?? origin.profile ?? (process.env.REEVAL_PROFILE || undefined)
  const loaded = await loadConfig(path, 'run', named)
  const own = origin.profile && loaded.profiles[origin.profile] ? origin.profile : undefined
  if (!wantsCloud(flags, loaded, selectProfile(loaded, flags.profile ?? own))) return null
  return {
    cloud: { config: loaded, origin },
    runId: undefined,
    nothing: null,
    saved: null,
    settings: null,
    notes: [],
    profileOf: undefined,
  }
}

/**
 * `--resume`: the run's saved settings with the flags given now. An older reeval's run saved none,
 * so it plans with the flags given now, with a note. With no such run here, `cloud` is the
 * config when it or the profile picked runs in the cloud, where the run is then continued.
 */
async function resumedRun(
  flags: Flags,
  filters: string[],
  configPath: string | undefined,
  bundled?: Bundled,
) {
  const path = requireConfig(configPath)
  // REEVAL_PROFILE and REEVAL_CONCURRENCY in a .env file are held to the run's like the shell's.
  loadEnvFiles(path)
  const root = dirname(path)
  const ref = flags.resume ?? flags['retry-errors']
  const named = ref && ref !== 'latest' ? await cloudContinuation(flags, path, ref, bundled) : null
  if (named) return named
  let target: Awaited<ReturnType<typeof continuedRun>>
  try {
    target = await continuedRun(root, flags, bundled)
  } catch (error) {
    if (!noRunHere(error) || flags.local) throw error
    const loaded = await loadConfig(
      path,
      'run',
      flags.profile ?? (process.env.REEVAL_PROFILE || undefined),
    )
    if (!wantsCloud(flags, loaded, selectProfile(loaded, flags.profile))) throw error
    return {
      cloud: { config: loaded, origin: null },
      runId: undefined,
      nothing: null,
      saved: null,
      settings: null,
      notes: [],
      profileOf: undefined,
    }
  }
  const downloaded = await cloudContinuation(flags, path, target.runId, bundled)
  if (downloaded) return downloaded
  if (
    flags['retry-errors'] !== undefined &&
    target.previous &&
    !erroredAttempts(target.previous).length
  ) {
    const nothing = {
      nothing: `run ${target.runId} has no infra errors, so --retry-errors has nothing to run again.`,
      record: target.previous,
    }
    return {
      runId: target.runId,
      nothing,
      saved: null,
      settings: null,
      notes: [],
      profileOf: undefined,
    }
  }
  if (
    flags.resume !== undefined &&
    (await stoppedRetry(root, target)) &&
    (filters.length || flags.tag?.length || flags.trait?.length)
  ) {
    throw new UsageError(
      `run ${target.runId} stopped during a --retry-errors, which runs every infra-errored attempt of the run again, with its plan: leave out filters, --tag and --trait.`,
    )
  }
  const saved = await savedInvocation(root, target)
  if (!saved) {
    const note = `run ${target.runId} saved no --runs, profile or filters, so this ${flags.resume === undefined ? 'retry' : 'resume'} plans with the ones given now`
    return {
      runId: target.runId,
      nothing: null,
      saved: null,
      settings: null,
      notes: [note],
      profileOf: undefined,
    }
  }
  const given = {
    runs: flags.runs,
    profile: flags.profile,
    concurrency: flags.concurrency,
    tag: flags.tag,
    trait: flags.trait,
    filters,
  }
  const flag = flags.resume === undefined ? '--retry-errors' : '--resume'
  const resumed = resumeSettings(target.runId, saved, given, { root, flag })
  const fromRun = flags.profile === undefined && resumed.settings.profile !== undefined
  return {
    runId: target.runId,
    nothing: null,
    saved,
    ...resumed,
    profileOf: fromRun ? target.runId : undefined,
  }
}

/** The run `--resume` continues, or the finished one `--retry-errors` runs the errors of again. */
const continuedRun = (
  root: string,
  flags: Pick<Flags, 'resume' | 'retry-errors'>,
  bundled?: Bundled,
) =>
  flags['retry-errors'] !== undefined
    ? resolveRetry(root, flags['retry-errors'] || undefined)
    : resolveResume(root, flags.resume || undefined, { movedIn: bundled !== undefined })

/**
 * Everything that can fail before the evals are collected: output mode, config, profile, flags.
 * `noProfile` is a resume of a run that had none, which `defaultProfile` mustn't give one;
 * `profileOf` names the resumed run whose profile `flags.profile` is.
 */
async function prepareRun(
  flags: Flags,
  configPath: string | undefined,
  { noProfile = false, profileOf }: { noProfile?: boolean; profileOf?: string } = {},
) {
  const output = resolveOutput({
    flags: {
      ui: flags.ui,
      logOrder: flags['log-order'],
      logPrefix: flags['log-prefix'],
      outputLogs: flags['output-logs'],
      verbose: verbosityOf(flags) > 0,
    },
    env: process.env,
    // A run's `--json` progress goes to stderr, so that's the stream whose terminal it draws on.
    isTTY: !!(flags.json && !flags['dry-run'] ? process.stderr : process.stdout).isTTY,
    agent: detectAgent().name,
    stdinTTY: !!process.stdin.isTTY && !flags.json && !flags['dry-run'],
  })
  const path = requireConfig(configPath)
  const listing = !!(flags['dry-run'] && flags.json)
  const tracked = listing ? (await import('./inputs-load.ts')).trackLoad(dirname(path)) : undefined
  let configInputs: LocalInput[] = []
  let loaded: Awaited<ReturnType<typeof loadConfig>>
  const named = noProfile ? undefined : (flags.profile ?? (process.env.REEVAL_PROFILE || undefined))
  try {
    loadEnvFiles(path)
    loaded = await loadConfig(path, 'run', named)
  } finally {
    if (tracked) configInputs = tracked.stop(path, 'config')
  }
  if (profileOf && flags.profile && !loaded.profiles[flags.profile]) {
    throw new UsageError(
      `run ${profileOf} was started with profile ${flags.profile}, which ${loaded.file} no longer defines. Put it back to resume the run, or start a new run without --resume.`,
    )
  }
  const profile = noProfile ? null : selectProfile(loaded, flags.profile)
  const config = withProfileHistory(loaded, profile)
  const recording =
    flags.record ||
    (profile?.record ?? config.record) === 'always' ||
    ((profile?.record ?? config.record) === 'ci' && inCI())
  // A cloud run's credentials are checked once it's known to run here.
  if (recording && !flags['dry-run'] && !wantsCloud(flags, config, profile)) {
    storeCredentials(config.history)
  }
  let runs: number | undefined
  if (flags.runs !== undefined) {
    runs = Number(flags.runs)
    if (!(Number.isInteger(runs) && runs >= 1)) {
      throw new UsageError(`--runs must be a whole number of at least 1 (got ${flags.runs})`)
    }
  }
  const sandboxes = [
    ...(config.environments.length ? config.environments : [undefined]).map((e) =>
      environmentSandbox(e, config.sandbox),
    ),
    ...(profile ? [profileSandbox(config, profile.defaults)] : []),
  ]
  const concurrency = givenConcurrency(config, flags.concurrency)
  const registry = await registryFlag(flags)
  return {
    output,
    config,
    profile,
    runs,
    tags: [...(flags.tag ?? []), ...(profile?.tags ?? [])],
    traits: traitFlags(flags.trait),
    sandboxes,
    /**
     * The run's concurrency. Without one given, it's sized from where the first sandbox that
     * runs off the host runs (the Docker or Podman VM, the Boat account) when it answers, as a
     * real run is, so --dry-run shows the same; a resume reads it once the stopped run's
     * sandboxes are gone, since they count against it.
     */
    sizeRun: async () =>
      concurrency ?? defaultConcurrency((await sandboxCapacity(sandboxes)) ?? hostCapacity()),
    budget: profile?.budget ?? config.budget,
    record: profile?.record ?? config.record,
    /** Whether the run is recorded into the history once it ends. */
    recording: !!recording,
    dryRun: !!flags['dry-run'],
    json: !!flags.json,
    /** What loading the config read, for `--dry-run --json`'s `inputs`. */
    configInputs,
    force: !!flags.force,
    /** `--registry`: where a missing sandbox image is pulled from before it's built. */
    registry,
    verbosity: verbosityOf(flags),
    configFile: configLabel(path),
    /** Named in the plan line when the project root isn't the current directory. */
    configElsewhere: dirname(path) !== process.cwd(),
    /** `undefined` is a new run; `''` is newest resumable; a string is a run id or prefix. */
    resume: flags.resume,
    /** Like `resume`, for `--retry-errors`. */
    retry: flags['retry-errors'],
  }
}

type Prepared = Awaited<ReturnType<typeof prepareRun>>

/** `--registry`, checked, or null; `--push` needs it. */
async function registryFlag(flags: Flags): Promise<string | null> {
  if (flags.push && flags.registry === undefined) {
    throw new UsageError(
      '--push needs --registry, the registry to push to, e.g. --registry ghcr.io/acme/reeval',
    )
  }
  if (flags.registry === undefined) return null
  const { registryProblem } = await import('@reeval/sandbox-docker')
  const problem = registryProblem(flags.registry)
  if (problem) throw new UsageError(problem)
  return flags.registry.replace(/\/+$/, '')
}

type StartedRun = RunContext & {
  startedAt: Date
  git: GitInfo | null
  worktreePatch: Buffer | null
  author: string
  /** `.reeval/runs`, where the run is written. */
  scratch: string
  previous: import('./history/types.ts').RunRecord | null
  previousArtifacts: string | null
  /** A retry's run, prepared once its plan is known to be the run's. */
  /** `--retry-errors`'s run, which it moves aside only once its plan is the run's. */
  retryTarget?: ResumeTarget
  /** The `.reeval/cloud` marker a retry removed as it set the run aside, which undoing it puts back. */
  forgotOrigin?: string
  /**
   * A `--retry-errors`, or a `--resume` that finishes one (`resume`), and when this process
   * started it; `startedAt` is the run's own start. `began`: when the retry a resume finishes
   * started, for one a kill stopped before the record listed it.
   */
  retry?: { startedAt: Date; resume: boolean; began?: Date }
}

/** What a retry, or a resume that finishes one, does to the run's errors, for its refusals. */
const retryVerb = (retry: { resume: boolean }, runId: string) =>
  retry.resume
    ? `--resume finishes run ${runId}'s --retry-errors, which runs its errors again`
    : '--retry-errors runs its errors again'

/** A run from a bundle: the bundled project's git state and author, which its copy lacks. */
type Bundled = { git: GitInfo | null; author?: string }

/** The run's id and the state it starts from: commit, uncommitted changes, author. */
async function startRun(
  {
    config,
    profile,
    runs,
    tags,
    traits,
    sandboxes,
    sizeRun,
    verbosity,
    configFile,
    resume,
    retry,
    dryRun,
  }: Prepared,
  bundled?: Bundled,
): Promise<StartedRun> {
  const startedAt = new Date()
  const git = bundled ? bundled.git : await gitInfo(config.root, [config.history.dir])
  const { worktreePatch } = await import('./history/state.ts')
  const patch =
    git?.dirty && !bundled ? await worktreePatch(config.root, [config.history.dir]) : null
  const who = bundled?.author ?? (await author(config.root))
  const { stagingDir } = await import('./results.ts')
  const { scratchDir } = await import('./history/files.ts')
  const scratch = scratchDir(config.root)
  if (resume !== undefined || retry !== undefined) {
    const target = await continuedRun(config.root, { resume, 'retry-errors': retry }, bundled)
    // A retry moves the finished run aside only once its plan is the run's.
    if (!dryRun && retry === undefined) {
      await prepareResume(target, config.root)
      await (await import('./cloud-files.ts')).forgetCloudOrigin(config.root, target.runId)
    } else if (!dryRun) holdRetry(target, config.root)
    const stopped = retry === undefined ? await stoppedRetry(config.root, target) : null
    if (!dryRun) await sweep(config.root, target.runId)
    const aside = dryRun
      ? { record: target.previous, artifacts: target.previousArtifacts }
      : await loadPrevious(stagingDir(config.root, target.runId))
    if (!dryRun) {
      await cleanupRun(target.runId).catch(() => {})
      // A kind that finds a run's machines only under a descriptor (Boat's account) gets the
      // config's here; per-eval ones, and those cleanup reaches only once planned, wait for the
      // plan (executeRun).
      const scoped = sandboxes.filter((s) => sandboxKind(s).cleanupScope?.(s)?.atStart)
      if (scoped.length) await cleanupRun(target.runId, scoped).catch(() => {})
    }
    const concurrency = await sizeRun()
    const { unfoldCases } = await import('./history/cases.ts')
    const previous = aside.record ?? target.previous
    return {
      runId: target.runId,
      stagingDir: stagingDir(config.root, target.runId),
      config,
      runs,
      tags,
      traits,
      concurrency,
      profile,
      verbosity,
      configFile,
      startedAt: target.startedAt,
      git,
      worktreePatch: patch,
      author: who,
      scratch,
      // Resume matches attempts by the entry each case ran as, so it reads the record that way.
      previous: previous && unfoldCases(previous),
      previousArtifacts: aside.artifacts ?? target.previousArtifacts,
      ...(retry === undefined ? {} : { retryTarget: target }),
      ...(retry !== undefined
        ? { retry: { startedAt, resume: false } }
        : stopped
          ? {
              retry: {
                startedAt,
                resume: true,
                ...(stopped.began ? { began: stopped.began } : {}),
              },
            }
          : {}),
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
  if (!dryRun) await sweep(config.root)
  const concurrency = await sizeRun()
  return {
    runId,
    // Workers create it with their first record; a run that never starts leaves nothing behind.
    stagingDir: stagingDir(config.root, runId),
    config,
    runs,
    tags,
    traits,
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
    `No evals matched ${config.include.join(', ')}${narrowed.length ? ` with ${narrowed.join(' and ')}` : ''}${maskedFilterHint(filters)}`,
  )
}

/**
 * Why a filter that holds a secret matches nothing: eval names are masked before they're
 * matched. Printed masked, it's the filter that would match.
 */
function maskedFilterHint(parts: string[]): string {
  const masked = parts.filter((p) => redactSecrets(p) !== p)
  if (!masked.length) return ''
  return `. Eval names are masked, so a filter that holds a secret can't match one: filter by the masked name (${masked.map((p) => `"${redactSecrets(p)}"`).join(', ')}) or a part of it without the secret`
}

function unmatchedFilter(config: StartedRun['config'], parts: string[]) {
  const which = parts.map((p) => `"${p}"`).join(', ')
  return new UsageError(
    `filter ${which} ${parts.length === 1 ? 'matches' : 'match'} no eval file, eval name or cell in ${config.include.join(', ')}${maskedFilterHint(parts)}`,
  )
}

/**
 * An eval whose id holds a value declared with `secret()`. `evaluate` masks names as the
 * worker's environment shows secrets, but a declared one is only known once the plan has the
 * environments, after the names became ids, so it's refused rather than written.
 */
function namesDeclaredSecret(evals: ReadonlyArray<{ id: string }>): UsageError | undefined {
  for (const { id } of evals) {
    const [file, ...names] = id.split(' › ')
    const masked = names.map((n) => redactSecrets(n))
    if (masked.every((n, i) => n === names[i])) continue
    return new UsageError(
      `${[file, ...masked].join(' › ')} names a secret declared with secret(): name it without the secret.`,
    )
  }
  return undefined
}

/**
 * Reads Cursor's model catalog for the planned Cursor cells (with a held CURSOR_API_KEY's value,
 * not its placeholder, so a bundle plans alike where it runs), checks their `effort` and `params`
 * against it (exit 2, naming the eval and cell), gives each the effort it runs at, and notes each
 * eval's harnesses that run with none. A catalog that can't be read leaves the Cursor cells
 * unchecked and noted; each attempt then reports why it couldn't start.
 */
async function planEfforts(planned: PlannedItem[]): Promise<CursorEfforts | undefined> {
  const live = planned.filter((p) => !p.attempt.plan.skip)
  const { effortNotes, withDefaultEffort } = await import('./harness/default-effort.ts')
  let cursor: CursorEfforts | undefined
  let unchecked = "CURSOR_API_KEY isn't set"
  const key = hostEnv().CURSOR_API_KEY
  if (key && !isPlaceholder(key) && live.some((p) => p.attempt.harness.kind === 'cursor')) {
    const { checkCursorPlan } = await import('./harness/cursor-catalog.ts')
    const checked = await checkCursorPlan(key, live)
    if (checked instanceof Error) {
      unchecked = `its request failed: ${checked.message}`
    } else {
      cursor = checked
      for (const p of planned) p.attempt.harness = withDefaultEffort(p.attempt.harness, cursor)
    }
  }
  const byEval = new Map<string, PlannedItem[]>()
  for (const p of live) byEval.set(p.id, [...(byEval.get(p.id) ?? []), p])
  for (const items of byEval.values()) {
    const notes = effortNotes(
      items.map((p) => p.attempt.harness),
      cursor,
      unchecked,
    )
    for (const { attempt } of items) {
      for (const note of notes)
        if (!attempt.plan.notes.includes(note)) attempt.plan.notes.push(note)
    }
  }
  return cursor
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
  started: {
    startedWith: RunInvocation | undefined
    notes: string[]
    /** A resume whose filters or `--tag` replace the run's, so its plan may leave attempts out. */
    narrowed: boolean
    /** The event stream file, as live.json names it. */
    events?: string
    /** The event stream's heartbeat of the attempts in progress. */
    heartbeat?: AttemptsBeat
    /** Where a run that asked for the cloud platform goes, and the dry run's line for it. */
    target?: RunTarget
    targetDetail?: string
  },
) {
  const { events } = started
  const { runId, stagingDir, config, runs, tags, traits, concurrency, profile, verbosity } = ctx
  const { configFile } = ctx
  const run = JSON.parse(
    JSON.stringify({
      runId,
      stagingDir,
      config,
      runs,
      tags,
      traits,
      concurrency,
      profile,
      verbosity,
      configFile,
      completed: [] as string[],
      ...(setup.dryRun && setup.json ? { inputs: true } : {}),
    }),
  ) as typeof ctx
  const { runEngine } = await import('./engine/node.ts')
  const {
    buildPlan,
    checkAttemptBudget,
    planDocument,
    planInputs,
    planLine,
    planTable,
    runHeader,
  } = await import('./plan.ts')
  let plan: RunPlan | undefined
  let sandboxVersions: SandboxVersions = { images: [] }
  let preflightStop: Error | undefined
  let reached = false
  let budgetTimer: NodeJS.Timeout | undefined
  let toRun: PlannedItem[] = []
  let live: LiveProgressWriter | undefined
  let kept = new Map<string, LiveKept>()
  let leftOut: LeftOut[] = []
  let retried = new Set<string>()
  let questions: QuestionRunner | undefined
  const onPlan = async (collected: CollectedPlan) => {
    const { planned, excluded, matched, unmatched } = collected
    if (unmatched.length) throw unmatchedFilter(config, unmatched)
    if (matched === 0) throw noMatch(config, filters, tags)
    checkLimitHarness(profile, config.file, collected)
    checkTraitKeys(traitFilters(traits, profile), collected.traits)
    const continuing = setup.resume !== undefined || ctx.retryTarget !== undefined
    const { errored } = continuing
      ? noteRetries(planned, stagingDir, ctx.previous, false)
      : { errored: new Set<string>() }
    const completed = completedKeysFor(planned, stagingDir, ctx.previous)
    // A retry runs the infra errors and the attempts a cancel stopped, and nothing else: not even
    // an attempt the run skipped, such as one a best-of cell didn't need.
    if (ctx.retry) {
      for (const { key } of planned) {
        const was = previousAttempt(ctx.previous, key)
        if (was && was.outcome !== 'infra_error') completed.add(key)
      }
    }
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
    const named = namesDeclaredSecret([...planned, ...excluded])
    if (named) throw named
    const efforts = await planEfforts(skipped)
    if (efforts) run.cursorEfforts = efforts
    if (ctx.retry && ctx.previous) {
      // The record keeps the run's stack, so the attempts it runs again run on the same reeval.
      const ranOn = ctx.previous.stack?.reeval
      if (ranOn && ranOn !== version) {
        throw new UsageError(
          `run ${runId} ran on reeval ${ranOn}, and this is ${version}. ${retryVerb(ctx.retry, runId)} only on the reeval they ran on: install reeval ${ranOn}, or start a new run with reeval run.`,
        )
      }
      const { retryChanges } = await import('./retry.ts')
      const { judgePart } = await import('./history/assemble.ts')
      const { engineVersions } = await import('./engine/node.ts')
      const judged = judgePart(config, profile, version, engineVersions)
      const runs = new Set(planned.map((p) => p.key).filter((key) => !completed.has(key)))
      const changes = await retryChanges(ctx.previous, planned, runs, config.root, judged)
      if (changes.length) {
        throw new UsageError(
          `run ${runId}'s plan changed since it ran: ${changes.join('; ')}. ${retryVerb(ctx.retry, runId)} only with the plan they ran with: put it back, or start a new run with reeval run.`,
        )
      }
      if (ctx.retryTarget && !setup.dryRun) {
        await prepareResume(ctx.retryTarget, config.root, { held: true })
        const { forgetCloudOrigin } = await import('./cloud-files.ts')
        const forgot = await forgetCloudOrigin(config.root, runId)
        if (forgot !== null) ctx.forgotOrigin = forgot
        const aside = await loadPrevious(stagingDir)
        ctx.previous = aside.record ?? ctx.previous
        ctx.previousArtifacts = aside.artifacts
      }
    }
    retried =
      continuing && !setup.dryRun
        ? noteRetries(planned, stagingDir, ctx.previous, true).errored
        : errored
    const asks = skipped.some((p) => !p.attempt.plan.skip && p.attempt.plan.questions?.length)
    const models = asks ? await import('./analysis/model.ts') : undefined
    const judge = runJudgeModel(config, profile)
    const judgeModel = judge === undefined ? null : judgeModelName(judge)
    plan = await buildPlan({
      planned: skipped,
      profile,
      budget: setup.budget,
      concurrency,
      root: config.root,
      historyDir: config.history.dir,
      questionModel: models?.questionModelLabel(config, judge) ?? null,
      judgeModel,
      ...(setup.dryRun ? { prices: await dryRunPrices(skipped, judgeModel) } : {}),
      ...(efforts ? { cursorEfforts: efforts } : {}),
    })
    plan.runId = runId
    const cloud = ciRunner(process.env)
    const direct = cloud
      ? [
          ...new Set(
            skipped
              .filter((p) => !p.attempt.plan.skip && capabilitiesOf(p.attempt.sandbox).isolated)
              .filter(
                (p) =>
                  isDirect(p.attempt.egress.policy) ||
                  isDirect(setupEgress(p.attempt.egress).policy),
              )
              .map((p) => p.id),
          ),
        ]
      : []
    if (cloud && direct.length) {
      plan.warnings.push(
        `${directOnCloud(cloud)}. Under it: ${direct.join(', ')}. Keep 'allow-all' to the evals that need raw TCP or UDP; the default, 'proxy', sends everything through the gateway`,
      )
    }
    const switching =
      concurrency > 1
        ? [
            ...new Set(
              skipped
                .filter(
                  ({ attempt }) =>
                    !attempt.plan.skip &&
                    !!attempt.egress.setup &&
                    attempt.sandbox.kind === 'docker' &&
                    attempt.sandbox.engine === 'podman',
                )
                .map((p) => p.id),
            ),
          ]
        : []
    const { podmanRootless } = await import('./sandbox/providers.ts')
    if (switching.length && (await podmanRootless())) {
      plan.warnings.push(rootlessPodmanSwitch(switching))
    }
    plan.warnings.push(...started.notes)
    if (started.narrowed) {
      leftOut = leftOutAttempts(
        planned,
        stagingDir,
        ctx.previous,
        await liveAttempts(stagingDir),
        new Set(excluded.map((e) => e.id)),
      )
      const notRun = leftOut.filter((l) => !l.done).length
      if (notRun) {
        plan.warnings.push(
          `${notRun === 1 ? '1 attempt' : `${notRun} attempts`} run ${runId} planned ${notRun === 1 ? "isn't" : "aren't"} in this resume's filters: ${notRun === 1 ? 'it stays' : 'they stay'} not run and the run stays incomplete. reeval run --resume ${runId} runs ${notRun === 1 ? 'it' : 'them'}`,
        )
      }
    }
    if (completed.size || retried.size) {
      plan.resume = {
        runId,
        completed: completed.size,
        ...(retried.size ? { retried: retried.size } : {}),
      }
    }
    run.completed = [...completed]
    const done = leftOut.filter((l) => l.done).map((l) => l.key)
    kept = keptAttempts([...completed, ...done], stagingDir, ctx.previous)
    const { imageStages, imageTargets } = await import('./sandbox/images.ts')
    const targets = imageTargets(
      skipped
        .filter((p) => !p.attempt.plan.skip)
        .map((p) => ({
          id: p.attempt.family?.id ?? p.id,
          harness: p.attempt.harness,
          sandbox: p.attempt.sandbox,
          plugins: p.attempt.pluginBuilds ?? [],
        })),
    )
    if (setup.json && setup.dryRun) {
      const images = await Promise.all(
        targets.map(async (t) => ({
          id: t.id,
          harness: t.harness,
          evals: t.evals,
          stages: await imageStages(t, config.root),
        })),
      )
      const { lockfiles } = await import('./history/state.ts')
      const locks = (await lockfiles(config.root)).map(({ path }) => ({
        path: join(config.root, path),
        kind: 'lockfile' as const,
      }))
      const inputs = planInputs(config.root, [...setup.configInputs, ...locks], skipped)
      const running = skipped.filter((p) => !p.attempt.plan.skip)
      const secrets = new Set(running.flatMap((p) => p.attempt.secretVars))
      const needed = neededCredentials(config, {
        harnesses: plan.harnessDescriptors,
        sandboxes: plan.sandboxes,
        profile,
        judges: running.flatMap((p) => (p.attempt.judge ? [p.attempt.judge] : [])),
      })
      for (const { names, cloudSets } of needed) {
        if (!cloudSets) for (const name of names) secrets.add(name)
      }
      const cloudSets = new Set(
        needed.flatMap((c) => (c.cloudSets ? c.names : [])).filter((name) => !secrets.has(name)),
      )
      for (const name of cloudSets) secrets.add(name)
      const { notCloud } = await import('./cloud-run.ts')
      const blocked = notCloud(skipped)
      const doc: PlanDocument = {
        ...planDocument(plan, skipped, excluded, images, inputs, [...secrets].sort()),
        ...(cloudSets.size ? { cloudSets: [...cloudSets].sort() } : {}),
        ...(blocked.length ? { notCloud: blocked } : {}),
        ...(started.target ? { target: started.target } : {}),
      }
      process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`)
      return false
    }
    const elsewhere = setup.configElsewhere ? configFile : undefined
    const { scratchDir } = await import('./history/files.ts')
    const lines: string[] = []
    if (setup.dryRun) {
      const todos = excluded.filter((e) => e.mode === 'todo').map((e) => e.id)
      lines.push(...planTable(plan, todos))
      const { imageStatusLines } = await import('./sandbox/images.ts')
      const { dockerAvailable, engineSpec } = await import('@reeval/sandbox-docker')
      const engines = [...new Set(targets.map((t) => t.sandbox.engine ?? 'docker'))]
      const down: typeof engines = []
      for (const engine of engines) if (!(await dockerAvailable(engine))) down.push(engine)
      if (targets.length && !down.length) {
        lines.push(...(await imageStatusLines(targets, config.root)))
      } else if (targets.length) {
        const names = down.map((e) => engineSpec(e).name).join(' and ')
        lines.push(`images  not checked: ${names} ${down.length === 1 ? 'is' : 'are'} not running`)
      }
      const { costLine } = await import('./cost.ts')
      const cost = plan.cost && costLine(plan.cost)
      if (cost) lines.push(cost)
      if (started.targetDetail) lines.push(started.targetDetail)
    }
    renderer.onEvent({
      type: 'plan',
      at: Date.now(),
      line: planLine(plan, elsewhere, runId),
      header: runHeader(plan, skipped, {
        version,
        runId,
        dryRun: setup.dryRun,
        config: elsewhere,
        judge: judgeModel,
        sandboxes: plannedSandboxIds(plan.sandboxes, profileSandbox(config, profile?.defaults)),
        record: fromCwd(join(scratchDir(config.root), `${runId}.json`)),
      }),
      details: lines,
      warnings: plan.warnings,
      hints: plan.hints,
      sandboxWarnings: plan.sandboxWarnings,
    })
    if (setup.dryRun) return false
    await reapOrphans(plan.sandboxes)
    if (continuing) {
      // startRun cleared this machine and the config's Boat accounts before the plan named the
      // Macs and the evals' own Boat accounts the run's VMs were on.
      const away = new Map<string, SandboxDescriptor>()
      for (const { attempt } of planned) {
        const { sandbox } = attempt
        const scope = sandboxKind(sandbox).cleanupScope?.(sandbox)
        if (scope) away.set(`${sandbox.kind}\0${scope.key}`, sandbox)
      }
      if (away.size) await cleanupRun(runId, [...away.values()]).catch(() => {})
    }
    checkAttemptBudget(plan, setup.force, config.file)
    const questionModels = new Set<string>()
    const asked: EvalQuestions[] = []
    const scope = gatewayScope(config, profile)
    for (const row of plan.rows) {
      if (row.plan.skip || !models) continue
      const questions = (row.plan.questions ?? []).map((q) => {
        const model = models.questionModel(config, q, row.id, judge)
        const gateway = resolveModelGateway(model, undefined, scope, 'the question model')
        return {
          n: q.n,
          question: q.question,
          model,
          ...(gateway ? { gateway } : {}),
          ...(gateway === 'openrouter' && openRouterFallbacks(scope.gateways)
            ? { fallbacks: true }
            : {}),
          ...(gateway === 'vertex' ? { vertex: vertexSettingsIn(scope.gateways) } : {}),
          ...(q.across !== undefined ? { across: q.across } : {}),
          ...(q.choices ? { choices: q.choices } : {}),
          state: q.state,
          ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
        }
      })
      for (const q of questions) if (typeof q.model === 'string') questionModels.add(q.model)
      if (questions.length) asked.push({ row, questions })
    }
    const judges = new Map<string, PlannedJudge>()
    for (const p of skipped) {
      const j = p.attempt.judge
      if (j && !p.attempt.plan.skip) judges.set(`${j.model}\0${j.gateway ?? ''}`, j)
    }
    const missing = missingCredentials(config, process.env, {
      harnesses: plan.harnessDescriptors,
      sandboxes: plan.sandboxes,
      profile,
      questionModels: [...questionModels],
      judges: [...judges.values()],
    })
    if (missing.length) {
      const hint = missing.some((m) => m.includes('(for direct())'))
        ? unusedGatewayKey(process.env)
        : ''
      throw new UsageError(
        `Missing credentials: ${missing.join('; ')}. Set them in the environment or .env.local.${hint}`,
      )
    }
    const malformed = malformedCredentials(config, process.env, {
      harnesses: plan.harnessDescriptors,
      profile,
      questionModels: [...questionModels],
      judges: [...judges.values()],
    })
    if (malformed.length) {
      throw new UsageError(
        `Credentials with whitespace or a line break in them: ${malformed.join(', ')}. A key copied from a wrapped terminal line picks these up; set it again as one line.`,
      )
    }
    if (asked.length) {
      const { questionRunner } = await import('./compare/questions.ts')
      const warned = new Set<string>()
      questions = questionRunner({
        evals: asked,
        stagingDir,
        resumed: {
          completed: new Set(run.completed),
          previous: ctx.previous,
          artifacts: ctx.previousArtifacts,
        },
        maxInputTokens: config.analysis.maxInputTokens,
        maxOutputTokens: config.analysis.maxOutputTokens,
        onAnswer: (id, answer) => {
          if (answer.error === undefined) return
          renderer.onEvent({
            type: 'notice',
            at: Date.now(),
            level: 'warn',
            text: `question "${clip(answer.question, 80)}" on ${id} failed: ${answer.error}. Outcomes are unchanged.`,
          })
        },
        onAttemptAnswer: (id, attempt, answer) => {
          const once = `${id}\0${answer.question}`
          if (answer.error === undefined || warned.has(once)) return
          warned.add(once)
          renderer.onEvent({
            type: 'notice',
            at: Date.now(),
            level: 'warn',
            text: `question "${clip(answer.question, 80)}" on ${attempt} failed: ${answer.error}. Outcomes are unchanged; later failures of it on ${id} aren't shown.`,
          })
        },
        onUnshown: (id, error) => {
          renderer.onEvent({
            type: 'notice',
            at: Date.now(),
            level: 'warn',
            text: `${error} on ${id}, so each attempt's answer is that error. Outcomes are unchanged.`,
          })
        },
      })
    }
    const { prepareWorkspaces, sameTreeArms, workspaceKey } = await import('./workspace.ts')
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
        plugins: [],
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
    for (const text of sameTreeArms(live, outcomes)) {
      renderer.onEvent({ type: 'notice', at: Date.now(), level: 'warn', text })
    }
    try {
      sandboxVersions = await preflight(
        skipped
          .filter((p) => !p.attempt.plan.skip)
          .map((p) => ({
            harness: p.attempt.harness,
            sandbox: p.attempt.sandbox,
            plugins: p.attempt.pluginBuilds ?? [],
            setBy: p.attempt.setBy,
          })),
        {
          root: config.root,
          runId,
          onEvent: (e) => {
            trace?.prepare(e)
            renderer.onEvent({ type: 'prepare', at: Date.now(), ...e })
          },
          ...(setup.registry ? { registry: setup.registry } : {}),
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
  // A signal once the engine has returned finds no attempt left to cancel: the run isn't cut short.
  let cutShort = false
  const { MACHINES, MachineService } = await import('./sandbox/machine-service.ts')
  const machines = new MachineService()
  const { TRACE } = await import('./trace/spans.ts')
  const { RunTrace } = await import('./trace/run.ts')
  const { otlpConfigured } = await import('./trace/otlp.ts')
  let exported: Promise<string | null> = Promise.resolve(null)
  let runStarted = false
  let telemetry: import('./trace/telemetry.ts').Telemetry | null = null
  const trace = setup.dryRun
    ? undefined
    : new RunTrace({
        dir: stagingDir,
        runId,
        onSpan: (span) => telemetry?.span(span),
        attributes: {
          'reeval.version': version,
          ...(profile && { 'reeval.profile': profile.name }),
        },
      }).install()
  if (trace && otlpConfigured(process.env)) {
    telemetry = (await import('./trace/telemetry.ts')).startTelemetry({
      version,
      traceId: trace.traceId,
      spanId: trace.spanId,
      runId,
      filesystems: { project: config.root, staging: stagingDir },
    })
  }
  if (telemetry) {
    const onEvent = renderer.onEvent.bind(renderer)
    const exporting = telemetry
    renderer.onEvent = (e) => {
      exporting.event(e)
      onEvent(e)
    }
  }
  try {
    engineRun = await runEngine({
      // Provided to every worker, so only what evals need; not the worktree patch. Plain data:
      // an environment's `extend` method doesn't cross to the workers.
      run,
      filters,
      onPlan,
      ...(started.heartbeat ? { heartbeat: beatWith(started.heartbeat, machines) } : {}),
      services: {
        call: (owner, service, body) =>
          service === MACHINES
            ? machines.call(owner, body)
            : service === TRACE
              ? (trace?.call(body) ?? Promise.resolve(null))
              : service === SECRETS_SERVICE
                ? Promise.resolve(heldSecrets())
                : Promise.reject(new Error(`This run has no ${service} service`)),
        released: (owner) => machines.released(owner),
      },
      onRunStart: (files) => {
        runStarted = true
        writeCurrent(setup.config.root, runId)
        live = writeLiveProgress({
          dir: stagingDir,
          runId,
          startedAt: ctx.startedAt,
          planned: toRun,
          kept,
          leftOut,
          ...(started.startedWith ? { invocation: started.startedWith } : {}),
          ...(events ? { events } : {}),
        })
        renderer.onEvent({
          type: 'run-start',
          at: Date.now(),
          version,
          files,
          harness: (plan?.harnesses ?? config.harness.map(harnessId)).join(', '),
          sandbox: plannedSandboxes(
            plan?.sandboxes ?? [],
            profileSandbox(config, profile?.defaults),
          ),
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
          questions?.onEvalEnd(e.result)
        }
        // Attempts cut short by Ctrl-C are reported from the merged record, in the summary.
        if (interrupted && e.type === 'eval-end' && e.result.state === 'skipped') return
        if (e.type === 'eval-progress' && e.progress.kind === 'secret-warning') {
          const { kind: _, at, ...warning } = e.progress
          return renderer.onEvent({ type: 'secret-warning', at, attemptId: e.key, ...warning })
        }
        renderer.onEvent(e)
      },
      // SIGTERM (docker stop, a CI runner's cancel) cancels like Ctrl-C.
      onCancelable: (cancel) => {
        let first:
          | { signal: NodeJS.Signals; at: number; passedOn?: boolean; attach?: boolean }
          | undefined
        const onSignal = (signal: NodeJS.Signals, attach: boolean) => {
          // A Ctrl-C this soon after attach's cancel is the same cancel: two senders' signals
          // reach the event loop in either order, so it takes the cancel's place as the first press.
          if (first?.attach && !attach && Date.now() - first.at < SAME_PRESS_MS) {
            stopCode = signal === 'SIGTERM' ? EXIT.terminated : EXIT.interrupted
            first = { signal, at: Date.now() }
            return
          }
          // pnpm passes the terminal's Ctrl-C on as a SIGTERM a moment after the SIGINT the CLI
          // already got: one press, not a second. The same signal again is a second press, however
          // soon: no launcher passes a SIGINT on as a SIGINT. Sent within a millisecond, the two
          // can arrive in either order, and either way the press was a Ctrl-C; a launcher passes it
          // on once, so any signal after that is a second press.
          if (
            first &&
            !first.passedOn &&
            signal !== first.signal &&
            Date.now() - first.at < SAME_PRESS_MS
          ) {
            if (signal === 'SIGINT') stopCode = EXIT.interrupted
            // pnpm exits once it has, and the shell takes the terminal back: another Ctrl-C
            // reaches the shell, not this process.
            if (!finishing)
              renderer.onEvent({
                type: 'notice',
                at: Date.now(),
                level: 'warn',
                text: `A launcher passed the Ctrl-C on and may have given the terminal back; the run still cancels and writes its record. kill ${process.pid} quits it at once, without a record`,
              })
            first.passedOn = true
            return
          }
          stopCode = signal === 'SIGTERM' ? EXIT.terminated : EXIT.interrupted
          if (interrupted) {
            renderer.close()
            process.stderr.write(red(`${quitWithoutRecord(runId, stagingDir)}\n`))
            finish(stopCode)
            process.exit(stopCode)
          }
          interrupted = true
          first = { signal, at: Date.now(), ...(attach ? { attach } : {}) }
          if (finishing) return
          questions?.cancel()
          live?.phase('cancelling')
          renderer.onEvent({
            type: 'notice',
            at: Date.now(),
            level: 'warn',
            text: "Canceling: stopping agents and destroying sandboxes, then writing the run's record. Ctrl-C again quits at once, without a record",
          })
          cancel()
        }
        process.on('SIGINT', () => onSignal('SIGINT', false))
        process.on('SIGTERM', () => onSignal('SIGTERM', false))
        // `reeval attach`'s cancel: a first Ctrl-C only, never the second that quits without a
        // record, however many viewers send it.
        if (process.platform !== 'win32') {
          process.on(CANCEL_SIGNAL, () => {
            if (!interrupted && !finishing) onSignal('SIGINT', true)
          })
        }
      },
    })
    cutShort = interrupted
  } catch (error) {
    live?.remove()
    throw error
  } finally {
    clearTimeout(budgetTimer)
    await machines.close()
    trace?.close({
      status: interrupted ? 'interrupted' : reached ? 'budget' : 'ran',
      started: runStarted,
    })
    // Awaited only once the run's record is written: a slow collector never holds it up.
    if (telemetry) exported = telemetry.close()
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
      `No eval files in ${config.root} match include: ${config.include.join(', ')}. Name eval files to match it, or set include in ${config.file}.`,
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
    cutShort,
    live,
    questions,
    exported,
    leftOut,
    /** The attempts that ran again after an infra error, by key; none on a dry run. */
    retried: setup.dryRun ? new Set<string>() : retried,
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
  // Its file is written before this returns; a POST still sending keeps the process up a moment.
  void eventStream?.end(code)
  const flags = invocation.flags
  let root = process.cwd()
  try {
    const configPath = flags ? configPathFor(flags.config) : findConfig()
    if (configPath) root = dirname(configPath)
  } catch {}
  const command = commandOf(argv)
  logInvocation(root, {
    at: new Date(startedAt).toISOString(),
    reeval: version,
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
  const broke =
    kind === 'crash' ||
    (code === EXIT.infra && !invocation.machineState) ||
    invocation.unhandledErrors.length > 0
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
      const infra = INFRA_ERRORS.includes(name)
      if (name === 'StoreError') invocation.machineState = true
      const expected = error instanceof UsageError || EXPECTED_ERRORS.includes(name) || infra
      console.error(red(`reeval: ${redactSecrets((error as Error).message)}`))
      if (!expected && process.env.REEVAL_DEBUG) console.error(redactSecrets(inspect(error)))
      const code = infra ? EXIT.infra : EXIT.usage
      finish(code, error, error instanceof UsageError ? 'usage' : expected ? 'expected' : 'crash')
      process.exitCode = code
    },
  )
