// Collects `reeval report`'s bundle: versions, `reeval doctor`, the config's shape, the last command, the
// run's failures and the slice of `.reeval/debug` behind them. Local files and local commands only:
// nothing here uses the network. Everything passes through the report's scrubber.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { Flags } from '../cli-spec.ts'
import { configPathFor, loadConfig } from '../config.ts'
import { attemptDebugDir, parseAttemptKey } from '../debug/files.ts'
import type { DoctorReport } from '../doctor.ts'
import { inCI, loadEnvFiles } from '../env.ts'
import { environmentSandbox, profileSandbox } from '../environment.ts'
import type { AttemptRecord, RunRecord } from '../history/types.ts'
import { SECRET_NAME } from '../redact.ts'
import { PACKAGE_VERSION } from '../root.ts'
import type { ResolvedConfig } from '../types.ts'
import { readInvocations } from './invocations.ts'
import { masks, registerEnvFileValues, type Scrubber, scrubber } from './scrub.ts'
import type { TarEntry } from './tar.ts'
import type { CliInvocation, ReportAttempt, ReportBundle } from './types.ts'

export type ReportDeps = {
  env: NodeJS.ProcessEnv
  cwd: string
  home: string
  platform: string
  release: string
  arch: string
  nodeVersion: string
  npmVersion: () => Promise<string | null>
  /** `reeval doctor --json`, offline. */
  doctor: (flags: Flags) => Promise<DoctorReport>
  agent: string | null
  now: () => Date
}

/** Failing attempts inlined in the bundle; the rest are counted, and their logs attached. */
export const MAX_FAILURES = 5
const LOG_LINES = 60
const TRACE_LINES = 20
const TRACE_LINE_CHARS = 500
/** Attached logs stop at this many bytes in all. */
export const MAX_ATTACHED_BYTES = 20 * 1024 * 1024

export type Collected = {
  bundle: ReportBundle
  /** Each failing attempt's full debug files, scrubbed, for `report-logs.tar.gz`. */
  attachments: TarEntry[]
  root: string
  scrub: Scrubber
}

/** `npm_config_user_agent` names the manager that ran `reeval`; else the project's lockfile. */
export function packageManager(
  env: NodeJS.ProcessEnv,
  root: string,
): ReportBundle['packageManager'] {
  const agent = /^(npm|pnpm|yarn|bun)\/(\S+)/.exec(env.npm_config_user_agent ?? '')
  if (agent) return { name: agent[1] as string, version: agent[2] as string, from: 'user agent' }
  const locks: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ]
  for (let dir = root; ; dir = dirname(dir)) {
    const hit = locks.find(([file]) => existsSync(join(dir, file)))
    if (hit) return { name: hit[1], version: null, from: hit[0] }
    if (dirname(dir) === dir) return null
  }
}

/** The config's keys and the kinds it uses; no value, model or path from it. */
export function configShape(config: ResolvedConfig): NonNullable<ReportBundle['config']> {
  const harnesses = new Set(config.harness.map((h) => h.kind))
  const sandboxes = new Set([environmentSandbox(config.environment, config.sandbox).kind])
  for (const profile of Object.values(config.profiles)) {
    for (const h of [profile.defaults?.harness ?? []].flat()) harnesses.add(h.kind)
    sandboxes.add(profileSandbox(config, profile.defaults).kind)
  }
  return {
    file: config.file,
    optionKeys: [...(config.optionKeys ?? [])].sort(),
    harnesses: [...harnesses],
    sandboxes: [...sandboxes],
    profiles: Object.entries(config.profiles).map(([name, p]) => ({
      name,
      keys: Object.keys(p).sort(),
      defaults: Object.keys(p.defaults ?? {}).sort(),
    })),
  }
}

const tail = (text: string, n: number) => text.trimEnd().split('\n').slice(-n)

const OMITTED_CONFIG = JSON.stringify({
  kind: 'config',
  omitted: "reeval report leaves the config's values out",
})

/** A trace without its `config` entries, which hold the config's values. */
const withoutConfig = (trace: string) =>
  trace
    .split('\n')
    .map((line) => {
      if (!line.includes('"kind":"config"')) return line
      try {
        return (JSON.parse(line) as { kind?: string }).kind === 'config' ? OMITTED_CONFIG : line
      } catch {
        return line
      }
    })
    .join('\n')

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll('\\', '/'))
    .sort()
}

function failedAttempts(record: RunRecord): AttemptRecord[] {
  return record.evals.flatMap((e) =>
    e.attempts.filter((a) => a.outcome === 'fail' || a.outcome === 'infra_error'),
  )
}

const cutLine = (l: string) =>
  l.length > TRACE_LINE_CHARS ? `${l.slice(0, TRACE_LINE_CHARS)}…` : l

/**
 * The last trace lines, each scrubbed before it's cut, so a value or path the cut goes through is
 * masked whole. `masked.added` counts the masks they hold beyond the lines cut as they were read,
 * which are the ones reeval masked before the report.
 */
export function traceTail(text: string, scrub: Scrubber, masked = { added: 0 }): string[] {
  return tail(withoutConfig(text), TRACE_LINES)
    .filter(Boolean)
    .map((line) => {
      const kept = cutLine(scrub.json(line))
      masked.added += masks(kept) - masks(cutLine(line))
      return kept
    })
}

function attemptSlice(
  root: string,
  runId: string,
  attempt: AttemptRecord,
  scrub: Scrubber,
  masked: { added: number },
): ReportAttempt {
  const key = parseAttemptKey(attempt.key)
  const dir = key ? attemptDebugDir(root, runId, key.evalId, key.cell, key.n) : ''
  const requests = tail(read(join(dir, 'requests.ndjson')), 500).filter((line) => {
    try {
      const r = JSON.parse(line) as { allowed?: boolean; status?: number }
      return r.allowed === false || (r.status ?? 0) >= 400
    } catch {
      return false
    }
  })
  return {
    key: attempt.key,
    outcome: attempt.outcome,
    error: attempt.error,
    turnErrors: attempt.turns.flatMap((t) => (t.error ? [t.error] : [])),
    debugFiles: dir ? filesIn(dir) : [],
    debugLog: tail(read(join(dir, 'debug.log')), LOG_LINES).filter(Boolean),
    trace: traceTail(read(join(dir, 'trace.ndjson')), scrub, masked),
    requests: requests.slice(-20),
  }
}

async function findRun(
  config: ResolvedConfig,
  ref: string,
): Promise<{ record: RunRecord } | { error: string }> {
  const { allRuns } = await import('../commands.ts')
  const { resolveRun } = await import('../history/views.ts')
  const { readRecord, scratchDir } = await import('../history/files.ts')
  try {
    const entry = resolveRun(await allRuns(config), ref)
    const dir = entry.recorded ? config.history.dir : scratchDir(config.root)
    return { record: await readRecord(join(dir, `${entry.runId}.json`)) }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

/** Which command the report is about: the newest one, or with `--last` the newest that failed. */
export function pickInvocation(root: string, last: boolean): CliInvocation | null {
  const logged = readInvocations(root).filter((i) => i.command !== 'report')
  const picked = last ? logged.filter((i) => i.exitCode !== 0) : logged
  return picked.at(-1) ?? null
}

/** Collects the bundle for `reeval report [run]`, scrubbed; see `ReportDeps` for what it reads. */
export async function collectReport(
  flags: Flags,
  refs: string[],
  deps: ReportDeps,
): Promise<Collected> {
  const configPath = configPathFor(flags.config)
  const root = configPath ? dirname(configPath) : deps.cwd
  loadEnvFiles(configPath)
  for (const name of ['.env.local', '.env']) {
    const contents = read(join(root, name))
    if (contents) registerEnvFileValues(contents)
  }
  const scrub = scrubber({ env: deps.env, home: deps.home, project: root })

  let config: ResolvedConfig | undefined
  let configError: string | null = null
  if (configPath) {
    try {
      config = await loadConfig(configPath, 'report')
    } catch (error) {
      configError = (error as Error).message
    }
  } else configError = 'no reeval.config.* here or above'

  const doctor = await deps.doctor({ config: flags.config }).catch((error: Error) => ({
    error: error.message,
  }))
  const invocation = pickInvocation(root, !!flags.last)

  let run: ReportBundle['run'] = null
  let runError: string | null = null
  const ref = refs[0] ?? (flags.last && invocation?.runId ? invocation.runId : 'latest')
  const attachments: TarEntry[] = []
  const attachedMasks = { before: 0, after: 0 }
  const traceMasks = { added: 0 }
  if (config) {
    const found = await findRun(config, ref)
    if ('error' in found) runError = found.error
    else {
      const { record } = found
      const failed = failedAttempts(record)
      const { runOutcome } = await import('../view/model.ts')
      run = {
        runId: record.runId,
        status: record.status,
        outcome: runOutcome(record),
        summary: { ...record.summary },
        stack: record.stack,
        failures: failed
          .slice(0, MAX_FAILURES)
          .map((a) => attemptSlice(root, record.runId, a, scrub, traceMasks)),
        moreFailures: Math.max(0, failed.length - MAX_FAILURES),
      }
      let bytes = 0
      for (const attempt of failed) {
        const key = parseAttemptKey(attempt.key)
        if (!key) continue
        const dir = attemptDebugDir(root, record.runId, key.evalId, key.cell, key.n)
        for (const file of filesIn(dir)) {
          const path = join(dir, file)
          const size = statSync(path).size
          if (bytes + size > MAX_ATTACHED_BYTES) continue
          bytes += size
          const text = readFileSync(path, 'utf8')
          const kept = file.endsWith('trace.ndjson') ? withoutConfig(text) : text
          const scrubbed = file.endsWith('.ndjson') ? scrub.json(kept) : scrub.text(kept)
          attachedMasks.before += masks(kept)
          attachedMasks.after += masks(scrubbed)
          attachments.push({
            path: relative(join(root, '.reeval', 'debug'), path).replaceAll('\\', '/'),
            data: Buffer.from(scrubbed),
          })
        }
      }
    }
  }

  const raw: ReportBundle = {
    kind: 'reeval-report',
    version: 1,
    createdAt: deps.now().toISOString(),
    reeval: PACKAGE_VERSION,
    node: deps.nodeVersion,
    npm: await deps.npmVersion(),
    os: { platform: deps.platform, release: deps.release, arch: deps.arch },
    packageManager: packageManager(deps.env, root),
    ci: inCI(deps.env),
    agent: deps.agent,
    env: Object.keys(deps.env)
      .filter((name) => name.startsWith('REEVAL_') || SECRET_NAME.test(name))
      .filter((name) => deps.env[name])
      .sort(),
    invocation,
    doctor,
    config: config ? configShape(config) : null,
    configError,
    run,
    runError,
    redaction: { masked: 0, upstream: 0, paths: scrub.paths },
  }
  const bundle = scrub.value(raw)
  // Counted as markers, so values reeval masked before the report read them (in the record, the
  // debug logs, the command log) count as well as the ones the report masks itself.
  const upstream = masks(JSON.stringify(raw)) - traceMasks.added + attachedMasks.before
  const masked = masks(JSON.stringify(bundle)) + attachedMasks.after
  bundle.redaction = { masked, upstream, paths: scrub.paths }
  return { bundle, attachments, root, scrub }
}
