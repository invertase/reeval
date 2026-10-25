// The deterministic remarks: hard thresholds over one run's facts and, for the kinds that need
// it, the history's derived views. No model is involved, so they print without one, except
// `no-baseline`, a rule on the model's classification. Pure: what the history and the eval's
// source say comes in through `RemarkContext`.
import { FLAKY_MIN_ATTEMPTS } from '../history/facts.ts'
import type { AttemptRecord, EvalEntry, RunRecord } from '../history/types.ts'
import { sha256 } from '../ids.ts'
import { clip } from '../text.ts'
import type { EvalInsight, Remark } from '../view/insights.ts'
import {
  type CellResult,
  EFFECT_MIN_COUNTED,
  type EvalResult,
  type SuiteResult,
} from '../view/suite.ts'

/** too-few-tries: the gap between two sides' pass rates that matters, as a fraction. */
export const TOO_FEW_TRIES_GAP = 0.5
/** check-never-fails: recorded default-branch runs in a row with no fail, and their tries. */
export const NEVER_FAILS_RUNS = 5
export const NEVER_FAILS_TRIES = 20
/** flaky-check: the newest comparable runs looked at, and how many must both pass and fail it. */
export const FLAKY_WINDOW = 5
export const FLAKY_RUNS = 2
/** slow-mcp-start: a stdio server this slow to answer `initialize`, in ms, or never. */
export const SLOW_MCP_MS = 2000

/** A remark before the run that first raised it is known. */
export type Candidate = Omit<Remark, 'firstSeenRun'>

/** A check's streak of clean recorded runs on the default branch (`check_streaks`). */
export type Streak = { runs: number; tries: number }
/** A check over a cell's newest comparable runs: runs that both passed and failed it, and its counts. */
export type CheckWindow = { runs: number; mixed: number; pass: number; fail: number }

/** What the rules read beyond the run: the history's views, and where text is in the eval's source. */
export type RemarkContext = {
  /** Null without history (no earlier run), or without a default branch for streaks. */
  history: {
    streak(evalKey: string, cellKey: string, label: string, fingerprint: string): Streak | null
    flaky(evalKey: string, cellKey: string, fingerprint: string): { cause: string } | null
    window(evalKey: string, cellKey: string, label: string, fingerprint: string): CheckWindow
  } | null
  /** A cell's fingerprint less agent runtime state, as the history pools runs on it. */
  comparable(entry: EvalEntry, cellKey: string): string
  /** `source:<file>#L<n>` of the first line naming `needle` in the eval's sources, else its file. */
  locate(entry: EvalEntry, needle: string | null): string
}

/** `KIND_ORDER` ranks remarks of one severity: the ones most worth acting on first. */
const KIND_ORDER: Remark['kind'][] = [
  'flaky-check',
  'judge-too-loose',
  'judge-leaks-answer',
  'name-contradicts',
  'prompt-names-tool',
  'no-baseline',
  'slow-mcp-start',
  'proxy-only-egress',
  'setup-process-secret',
  'too-few-tries',
  'compound-judge',
  'check-never-fails',
  'name-no-intent',
]

/** Remarks ranked: concerns first, then by kind, then in the order they came. */
export function rankRemarks<T extends Pick<Remark, 'severity' | 'kind'>>(remarks: T[]): T[] {
  const order = (r: T) => (r.severity === 'concern' ? 0 : 1) * 100 + KIND_ORDER.indexOf(r.kind)
  return remarks
    .map((r, i) => ({ r, i }))
    .sort((a, b) => order(a.r) - order(b.r) || a.i - b.i)
    .map(({ r }) => r)
}

/** sha256(kind, eval, the eval's sources[, what it's about]): one remark per kind per eval version. */
export function remarkId(kind: Remark['kind'], evalId: string, entry: EvalEntry, extra = '') {
  const sources = sha256(JSON.stringify(entry.sources.map((s) => [s.path, s.sha256])))
  return sha256(JSON.stringify([kind, evalId, sources, ...(extra ? [extra] : [])]))
}

/**
 * sha256(kind, eval, the quoted source text): a model remark's id. It holds while the quote is in
 * the file, so an edit elsewhere doesn't raise it again, and an edit to the quote acts on it.
 */
export const quotedRemarkId = (kind: Remark['kind'], evalId: string, quote: string) =>
  sha256(JSON.stringify([kind, evalId, 'quote', quote]))

const tries = (n: number) => `${n} ${n === 1 ? 'try' : 'tries'}`
const capital = (s: string) => `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`
const rate = (c: CellResult) => (c.passed + c.failed ? c.passed / (c.passed + c.failed) : 0)
const counted = (c: CellResult) => c.passed + c.failed

/** An eval's units of cells: its own, or each family case's with that case's eval id. */
function units(e: EvalResult): Array<{ id: string; cells: CellResult[] }> {
  if (e.cases) return e.cases.map((k) => ({ id: k.id, cells: k.cells }))
  return [{ id: e.id, cells: e.cells ?? [] }]
}

const armOf = (c: CellResult) => c.variant ?? (c.environment === '-' ? 'baseline' : c.environment)

/**
 * too-few-tries (suggestion): a variant and its baseline differ by at least `TOO_FEW_TRIES_GAP`,
 * with fewer than `EFFECT_MIN_COUNTED` counted tries on a side, so the effect reads "can't tell
 * yet" on a gap that matters. Equal rates never raise it.
 */
function tooFewTries(e: EvalResult, entry: EvalEntry, ctx: RemarkContext): Candidate[] {
  let worst: { variant: CellResult; base: CellResult; gap: number } | null = null
  for (const unit of units(e)) {
    for (const variant of unit.cells) {
      const base = unit.cells.find((c) => c.key === variant.vs)
      if (!variant.vs || !base || !counted(variant) || !counted(base)) continue
      if (Math.min(counted(variant), counted(base)) >= EFFECT_MIN_COUNTED) continue
      const gap = Math.abs(rate(variant) - rate(base))
      if (gap >= TOO_FEW_TRIES_GAP && (!worst || gap > worst.gap)) worst = { variant, base, gap }
    }
  }
  if (!worst) return []
  const { variant, base } = worst
  const harnesses = new Set(units(e).flatMap((u) => u.cells.map((c) => c.harness))).size > 1
  const on = harnesses ? ` on ${variant.harness}` : ''
  return [
    {
      id: remarkId('too-few-tries', e.path, entry),
      evalId: e.path,
      kind: 'too-few-tries',
      severity: 'suggestion',
      text: `${capital(armOf(variant))}${on} passed ${variant.passed} of ${tries(counted(variant))} and ${armOf(base)} ${base.passed} of ${counted(base)}: too few tries to tell whether the difference holds.`,
      evidence: [variant.path, base.path],
      fix: {
        at: ctx.locate(entry, null),
        edit: `set runs: ${EFFECT_MIN_COUNTED} or more, so each side counts at least ${EFFECT_MIN_COUNTED} tries`,
      },
      origin: 'deterministic',
    },
  ]
}

/** The record's tally of a check in a cell, with its variant verdict. */
const recordCheck = (entry: EvalEntry, cellKey: string, label: string) =>
  entry.cells.find((c) => c.key === cellKey)?.checks?.find((k) => k.label === label)

/**
 * check-never-fails (suggestion): in every cell of the eval, a check passed this run with no fail,
 * and its streak (`check_streaks`) on the default branch is at least `NEVER_FAILS_RUNS` recorded
 * runs and `NEVER_FAILS_TRIES` tries on the same setup; on a variant, it passed on both sides.
 */
function checkNeverFails(
  e: EvalResult,
  entries: (id: string) => EvalEntry | undefined,
  ctx: RemarkContext,
): Candidate[] {
  const history = ctx.history
  if (!history) return []
  const all = units(e)
  const labels = [
    ...new Set(all.flatMap((u) => u.cells.flatMap((c) => c.checks.map((k) => k.label)))),
  ]
  const found: Array<{ label: string; runs: number; tries: number; paths: string[] }> = []
  for (const label of labels) {
    let runs = Number.POSITIVE_INFINITY
    let total = Number.POSITIVE_INFINITY
    const paths: string[] = []
    const ok = all.every((u) => {
      const entry = entries(u.id)
      return (
        entry &&
        u.cells.every((cell) => {
          const k = cell.checks.find((x) => x.label === label)
          if (k?.outcome.status !== 'ran') return false
          if (k.outcome.failed || k.outcome.errored || !k.outcome.passed) return false
          if (cell.vs && recordCheck(entry, cell.key, label)?.verdict !== 'both-pass') return false
          const s = history.streak(u.id, cell.key, label, ctx.comparable(entry, cell.key))
          if (!s || s.runs < NEVER_FAILS_RUNS || s.tries < NEVER_FAILS_TRIES) return false
          runs = Math.min(runs, s.runs)
          total = Math.min(total, s.tries)
          paths.push(k.path)
          return true
        })
      )
    })
    if (ok && paths.length) found.push({ label, runs, tries: total, paths })
  }
  const [first] = found
  const entry = entries(all[0]?.id ?? '')
  if (!first || !entry) return []
  const compare = all.some((u) => u.cells.some((c) => c.vs))
  const more = found.length > 1 ? ` (and ${found.length - 1} more)` : ''
  const text = compare
    ? `"${first.label}"${more} passed with and without the change in each of the last ${first.runs} recorded runs, so it doesn't show a difference.`
    : `"${first.label}"${more} passed every try in the last ${first.runs} recorded runs (${first.tries} tries), so it never tells a good result from a bad one.`
  return [
    {
      id: remarkId('check-never-fails', e.path, entry),
      evalId: e.path,
      kind: 'check-never-fails',
      severity: 'suggestion',
      text,
      evidence: found.flatMap((f) => f.paths),
      fix: {
        at: ctx.locate(entry, first.label),
        edit: compare
          ? `make "${first.label}" check what the change affects, or remove it`
          : `make "${first.label}" strict enough to fail on a wrong result, or remove it`,
      },
      origin: 'deterministic',
    },
  ]
}

/**
 * flaky-check (concern): the cell is `flaky` in `flaky_cells` (at least `FLAKY_MIN_ATTEMPTS`
 * counted tries over comparable runs, not from infrastructure), and the check both passed and
 * failed in at least `FLAKY_RUNS` of the cell's newest `FLAKY_WINDOW` runs on the same setup.
 */
function flakyCheck(
  e: EvalResult,
  entries: (id: string) => EvalEntry | undefined,
  ctx: RemarkContext,
): Candidate[] {
  const history = ctx.history
  if (!history) return []
  const found: Array<{ label: string; window: CheckWindow; path: string; entry: EvalEntry }> = []
  for (const u of units(e)) {
    const entry = entries(u.id)
    if (!entry) continue
    for (const cell of u.cells) {
      const fingerprint = ctx.comparable(entry, cell.key)
      const flaky = history.flaky(u.id, cell.key, fingerprint)
      if (!flaky || flaky.cause === 'infra') continue
      for (const k of cell.checks) {
        if (k.outcome.status !== 'ran' || found.some((f) => f.label === k.label)) continue
        const window = history.window(u.id, cell.key, k.label, fingerprint)
        if (window.mixed >= FLAKY_RUNS && window.pass + window.fail >= FLAKY_MIN_ATTEMPTS) {
          found.push({ label: k.label, window, path: k.path, entry })
        }
      }
    }
  }
  const [first] = found
  if (!first) return []
  const { window: w } = first
  const more = found.length > 1 ? ` (and ${found.length - 1} more)` : ''
  return [
    {
      id: remarkId('flaky-check', e.path, first.entry),
      evalId: e.path,
      kind: 'flaky-check',
      severity: 'concern',
      text: `"${first.label}"${more} passed ${w.pass} of ${tries(w.pass + w.fail)} over ${w.runs} runs with nothing changed, so one try can pass or fail it.`,
      evidence: found.map((f) => f.path),
      fix: {
        at: ctx.locate(first.entry, first.label),
        edit: `make "${first.label}" check something every good try does, or raise runs so one try doesn't decide it`,
      },
      origin: 'deterministic',
    },
  ]
}

/** `<plugin>:<server>` is a plugin's server; any other name is a plain `mcp` one. */
function serverName(server: string): string {
  const at = server.indexOf(':')
  return at > 0
    ? `the ${server.slice(0, at)} plugin's MCP server ${server.slice(at + 1)}`
    : `MCP server ${server}`
}

/** `4s` from 4000 ms, `2.4s` from 2400, whole seconds from 10s. */
const seconds = (ms: number) => {
  const s = Math.round(ms / 100) / 10
  return `${s >= 10 ? Math.round(s) : s}s`
}

const slow = (ms: number | null) => ms === null || ms >= SLOW_MCP_MS

/**
 * slow-mcp-start (concern): a stdio MCP server took `SLOW_MCP_MS` or more to answer `initialize`,
 * or never answered, on some turn. One per server, over the eval's attempts. A harness that starts
 * its servers once a session records them on its first turn only, so the turns counted are the
 * ones that recorded the server.
 */
function slowMcpStart(e: EvalResult, entries: EvalEntry[], ctx: RemarkContext): Candidate[] {
  const cellPaths = new Map<string, string>()
  for (const u of units(e)) for (const c of u.cells) cellPaths.set(`${u.id}\0${c.key}`, c.path)
  const attempts: Array<{ entry: EvalEntry; attempt: AttemptRecord }> = entries.flatMap((entry) =>
    entry.attempts.map((attempt) => ({ entry, attempt })),
  )
  const servers = [
    ...new Set(
      attempts.flatMap(({ attempt }) =>
        attempt.turns.flatMap((t) => (t.mcpStartup ?? []).map((m) => m.server)),
      ),
    ),
  ]
  const out: Candidate[] = []
  for (const server of servers) {
    type Hit = {
      entry: EvalEntry
      attempt: AttemptRecord
      ms: number[]
      never: boolean
      turns: number
      slowTurns: number
    }
    const recorded: Hit[] = []
    for (const { entry, attempt } of attempts) {
      const turns = attempt.turns
        .map((t) => (t.mcpStartup ?? []).filter((m) => m.server === server))
        .filter((starts) => starts.length > 0)
      if (!turns.length) continue
      const slowTurns = turns.filter((starts) => starts.some((m) => slow(m.ms))).length
      const starts = turns.flat()
      recorded.push({
        entry,
        attempt,
        ms: starts.flatMap((m) => (m.ms !== null && m.ms >= SLOW_MCP_MS ? [m.ms] : [])),
        never: starts.some((m) => m.ms === null),
        turns: turns.length,
        slowTurns,
      })
    }
    const hits = recorded.filter((h) => h.slowTurns > 0)
    const worst = [...hits].sort(
      (a, b) => Number(b.never) - Number(a.never) || Math.max(0, ...b.ms) - Math.max(0, ...a.ms),
    )[0]
    if (!worst) continue
    const first = hits[0] as Hit
    const what = worst.never
      ? `${serverName(server)} never answered within the start-up timeout`
      : `${serverName(server)} took ${seconds(Math.max(...worst.ms))} to start`
    const turns =
      worst.turns > 1
        ? worst.slowTurns === worst.turns
          ? ` on each of ${worst.turns} turns`
          : ` on ${worst.slowTurns} of ${worst.turns} turns`
        : ''
    const ofTries = recorded.length > 1 ? `, in ${hits.length} of ${recorded.length} tries` : ''
    const name = server.includes(':') ? server.slice(0, server.indexOf(':')) : server
    out.push({
      id: remarkId('slow-mcp-start', e.path, first.entry, server),
      evalId: e.path,
      kind: 'slow-mcp-start',
      severity: 'concern',
      text: `${capital(what)}${turns}${ofTries}.`,
      evidence: hits.map(
        (h) => `${cellPaths.get(`${h.entry.id}\0${h.attempt.cell}`) ?? h.entry.id}#${h.attempt.n}`,
      ),
      fix: {
        at: ctx.locate(first.entry, name),
        edit: worst.never
          ? `run ${server}'s command in the sandbox with c.exec to see why it doesn't answer initialize`
          : `install what ${server} needs in the image (install or dockerfile), so it doesn't fetch or build it at start-up`,
      },
      origin: 'deterministic',
    })
  }
  return out
}

/**
 * What a client prints when it can't connect, resolve a name or find a route: under `proxy` the
 * sandbox has no network of its own, so a client that ignores the proxy fails with one of these.
 */
const CONNECTION_ERROR =
  /\b(?:ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b|network is unreachable|no route to host|connection refused|could not resolve host|temporary failure in name resolution|name or service not known|could not translate host name|getaddrinfo/i

/** The record's text an attempt failed with: its error, failed assertions and turns. */
const failureText = (a: AttemptRecord) => [
  a.error?.message ?? '',
  ...(a.assertions ?? []).filter((x) => x.status !== 'pass').map((x) => x.message ?? ''),
  ...a.turns.flatMap((t) => [t.text, t.error ?? '']),
]

/**
 * proxy-only-egress (concern): an attempt under `proxy` failed with a connection error, and the
 * gateway refused nothing, so the connection never reached it: a raw TCP or UDP client (SSH, a
 * database driver), or one that ignores `HTTPS_PROXY`. One per eval.
 */
function proxyOnlyEgress(e: EvalResult, entries: EvalEntry[], ctx: RemarkContext): Candidate[] {
  const cellPaths = new Map<string, string>()
  for (const u of units(e)) for (const c of u.cells) cellPaths.set(`${u.id}\0${c.key}`, c.path)
  const hits = entries.flatMap((entry) =>
    entry.attempts.flatMap((attempt) => {
      if (attempt.outcome !== 'fail' && attempt.outcome !== 'infra_error') return []
      const egress = attempt.egress
      if (egress?.policy !== 'proxy' || !egress.recorded || egress.blocked.length) return []
      const error = failureText(attempt)
        .map((t) => CONNECTION_ERROR.exec(t)?.[0])
        .find(Boolean)
      return error ? [{ entry, attempt, error }] : []
    }),
  )
  const [first] = hits
  if (!first) return []
  const ofTries = hits.length > 1 ? ` (${hits.length} tries)` : ''
  return [
    {
      id: remarkId('proxy-only-egress', e.path, first.entry),
      evalId: e.path,
      kind: 'proxy-only-egress',
      severity: 'concern',
      text: `It failed with "${first.error}"${ofTries} and nothing reached the egress gateway: under egress 'proxy' only HTTP(S) through the gateway leaves the sandbox, so raw TCP, UDP, SSH and database connections fail.`,
      evidence: hits.map(
        (h) => `${cellPaths.get(`${h.entry.id}\0${h.attempt.cell}`) ?? h.entry.id}#${h.attempt.n}`,
      ),
      fix: {
        at: ctx.locate(first.entry, null),
        edit: "set egress: 'allow-all' on the eval if it needs raw TCP or UDP, or point the client at HTTPS_PROXY",
      },
      origin: 'deterministic',
    },
  ]
}

/**
 * setup-process-secret (concern): a setup step left a process running with a `to: 'checks'` secret
 * without `hosts` in its environment (`setupProcesses`), so it holds the real value while the agent,
 * as the same user, works beside it. One per eval.
 */
function setupProcessSecret(e: EvalResult, entries: EvalEntry[], ctx: RemarkContext): Candidate[] {
  const cellPaths = new Map<string, string>()
  for (const u of units(e)) for (const c of u.cells) cellPaths.set(`${u.id}\0${c.key}`, c.path)
  const hits = entries.flatMap((entry) =>
    entry.attempts.flatMap((attempt) =>
      attempt.setupProcesses?.length ? [{ entry, attempt, processes: attempt.setupProcesses }] : [],
    ),
  )
  const [first] = hits
  if (!first) return []
  const secrets = [...new Set(hits.flatMap((h) => h.processes.flatMap((p) => p.secrets)))]
  const commands = [...new Set(hits.flatMap((h) => h.processes.map((p) => p.command)))]
  const more = commands.length > 1 ? ` (and ${commands.length - 1} more)` : ''
  const ofTries = hits.length > 1 ? ` in ${hits.length} tries` : ''
  const [secret = ''] = secrets
  const list = secrets.join(', ')
  const which = secrets.length > 1 ? "to: 'checks' secrets" : "a to: 'checks' secret"
  const [its, those] = commands.length > 1 ? ['their', 'those processes'] : ['its', 'that process']
  return [
    {
      id: remarkId('setup-process-secret', e.path, first.entry),
      evalId: e.path,
      kind: 'setup-process-secret',
      severity: 'concern',
      text: `Setup left "${clip(commands[0] ?? '', 80)}"${more} running with ${list}, ${which} without hosts, in ${its} environment${ofTries}, so the agent can read the real value from ${those}.`,
      evidence: hits.map(
        (h) => `${cellPaths.get(`${h.entry.id}\0${h.attempt.cell}`) ?? h.entry.id}#${h.attempt.n}`,
      ),
      fix: {
        at: ctx.locate(first.entry, secret),
        edit: `broker ${secret} with the hosts the process sends it to, e.g. secret({ to: 'checks', hosts: ['api.example.com'] }), so it holds a placeholder, or start the process from c.exec after the agent's turn`,
      },
      origin: 'deterministic',
    },
  ]
}

/**
 * no-baseline (concern): the classification says the eval is about a change (`subject.change`),
 * but it declares no compare, so nothing shows what the change does. A profile's
 * `limit.compare: false` stripped the compare on purpose, so it never raises it.
 */
export function noBaseline(
  suite: SuiteResult,
  record: RunRecord,
  insights: EvalInsight[],
  ctx: RemarkContext,
): Candidate[] {
  if (record.profile?.limit.compare === false) return []
  const intents = new Map(insights.map((i) => [i.evalId, i.intent]))
  const byId = new Map(record.evals.map((e) => [e.id, e]))
  const out: Candidate[] = []
  for (const file of suite.files) {
    for (const e of [...file.evals].sort((a, b) => a.order - b.order)) {
      const change = intents.get(e.path)?.subject.change?.trim()
      if (!change || e.todo || e.outcome === 'skipped') continue
      const own = units(e).flatMap((u) => byId.get(u.id) ?? [])
      const first = own[0]
      if (!first || own.some((x) => x.compare)) continue
      if (units(e).some((u) => u.cells.some((c) => c.vs))) continue
      out.push({
        id: remarkId('no-baseline', e.path, first),
        evalId: e.path,
        kind: 'no-baseline',
        severity: 'concern',
        text: `It's about ${change}, but nothing runs it without ${change}, so the result can't show what ${change} changes.`,
        evidence: [e.path],
        fix: {
          at: ctx.locate(first, null),
          edit: `add compare: { baseline: <an environment without ${change}>, variants: [<one with it>] }`,
        },
        origin: 'deterministic',
      })
    }
  }
  return out
}

/** Every deterministic remark the run raises, ranked: concerns first, then by kind and eval. */
export function deterministicRemarks(
  suite: SuiteResult,
  record: RunRecord,
  ctx: RemarkContext,
): Candidate[] {
  const byId = new Map(record.evals.map((e) => [e.id, e]))
  const entries = (id: string) => byId.get(id)
  const out: Candidate[] = []
  for (const file of suite.files) {
    for (const e of [...file.evals].sort((a, b) => a.order - b.order)) {
      if (e.todo || e.outcome === 'skipped') continue
      const own = units(e).flatMap((u) => entries(u.id) ?? [])
      const first = own[0]
      if (!first) continue
      out.push(
        ...flakyCheck(e, entries, ctx),
        ...slowMcpStart(e, own, ctx),
        ...proxyOnlyEgress(e, own, ctx),
        ...setupProcessSecret(e, own, ctx),
        ...tooFewTries(e, first, ctx),
        ...checkNeverFails(e, entries, ctx),
      )
    }
  }
  return rankRemarks(out)
}
