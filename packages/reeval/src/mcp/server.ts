// `reeval mcp`'s server: run history as read-only MCP tools and resources. The same factory serves
// stdio and each stateless HTTP request, so it builds a fresh McpServer and holds nothing.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { allRuns, compareView, historyView, showRecord } from '../commands.ts'
import { openHistoryDb, VIEW_NAMES } from '../history/db.ts'
import { readRecord } from '../history/files.ts'
import { renderSummary } from '../history/summary.ts'
import type { RunRecord } from '../history/types.ts'
import { resolveRun } from '../history/views.ts'
import { statementCount } from '../query.ts'
import { redactJson, redactSecrets } from '../redact.ts'
import { resolveFile } from '../studio/source.ts'
import type { ResolvedConfig } from '../types.ts'
import { sortAnalyses } from '../view/analysis.ts'
import { RUN_ID } from '../view/paths.ts'
import { DEFAULT_FAILURES, DEFAULT_TAIL, failuresView } from './failures.ts'
import { readTranscript, source } from './files.ts'

/** Rows a query returns unless the caller asks for fewer; never more than `MAX_ROWS`. */
export const DEFAULT_ROWS = 100
export const MAX_ROWS = 1000
export const DEFAULT_LINES = 200

/** What each view has one row per, for its tool's description. */
const VIEW_ROWS: Record<string, string> = {
  lift: 'variant cell per run: its control, both sides’ pass counts and pass@1, lift points and the 95% interval (lo, hi), within_noise',
  family_lift:
    'variant cell per pooled evaluate.each per run: its control, paired cases, both sides’ mean pass@1 over them, lift points and the 95% interval (lo, hi), verdict and effort ratios',
  effort:
    'cell per run: attempts, median tool calls, agent seconds and tokens; for a variant, the ratios to its control, p-values and verdicts (tokens omitted when either side has no usage sample)',
  attempt_answers:
    'answer to a question asked of one attempt on its own (no across): the attempt, its outcome, the choice picked, the text, and the error when the call failed',
  factor_effects:
    'factor contrast (environment, harness, model) by evidence tier, with pass@1 and effort verdicts',
  skill_reads:
    'attempt and skill its environment placed: the transcript line of its first read (a path under skills/<name>/, or a skill / load_skill call), and how many',
  flaky_cells:
    'cell with mixed outcomes pooled over comparable runs: counts, a Wilson interval, a verdict and a likely cause',
  drift:
    'run where a cell’s fingerprint changed from its previous run, what changed, and noise = 1 when only agent runtime state did',
  failing_attempts:
    'failed or infra-error attempt, with its harness, model, environment skill, error, OOM kills and first failed check',
  eval_trend: 'eval per run: outcome, pass@1, branch, PR and fingerprint',
  verdict_flips: 'judge question per cell whose pass rate changed from its previous run',
  check_discrimination:
    'check (expect label) per variant cell per run: its passes, failures and not-run on both sides, and whether it discriminates (both-pass and both-fail checks measure nothing)',
  check_rates:
    'check (expect label) per cell per run, control and variant alike: harness, environment, role, passes, failures, errors, not-run and rate = pass / (pass + fail), null when none',
  check_streaks:
    'check (expect label) per cell, comparable fingerprint and branch over recorded runs: how many newest runs in a row it passed with no fail (on a variant, on both sides), their tries, and the run that ended the streak',
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const RUN_REF =
  'A run: latest (default), latest~N, a run id or unique prefix of one, or a git SHA prefix'

type Json = Record<string, unknown>

/** A tool's answer: the JSON as text and as structured content, masked like everything reeval writes. */
function result(value: Json) {
  const text = redactJson(value, 2)
  const structured = JSON.parse(text) as Json
  return { content: [{ type: 'text' as const, text }], structuredContent: structured }
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text' as const, text: redactSecrets(message) }], isError: true }
}

const guard =
  <A>(run: (args: A) => Promise<Json>) =>
  async (args: A) => {
    try {
      return result(await run(args))
    } catch (error) {
      return failure(error)
    }
  }

/** The first keyword of `sql`, past whitespace and comments, upper-cased. */
export function firstKeyword(sql: string): string {
  const rest = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '')
  return (/^[A-Za-z]+/.exec(rest)?.[0] ?? '').toUpperCase()
}

/**
 * Why `reeval mcp` won't run `sql`, or null. On top of the read-only connection: one `SELECT` or
 * `WITH` statement, so no `ATTACH` (another file), `PRAGMA` or `VACUUM INTO` (a new file).
 */
export function sqlProblem(sql: string): string | null {
  if (statementCount(sql) !== 1) return 'Send exactly one SQL statement.'
  const keyword = firstKeyword(sql)
  if (keyword !== 'SELECT' && keyword !== 'WITH') {
    return `Only SELECT and WITH statements run here (got ${keyword || 'nothing'}); the history is read-only.`
  }
  return null
}

type ViewColumns = Record<string, string[]>

/** Each view's columns, as `reeval query --schema --json` lists them. */
export async function viewColumns(config: ResolvedConfig): Promise<ViewColumns> {
  const db = await openHistoryDb(config.root, config.history.dir)
  try {
    const schema = db.schema()
    return Object.fromEntries(
      VIEW_NAMES.map((name) => [name, schema.find((o) => o.name === name)?.columns ?? []]),
    )
  } finally {
    db.close()
  }
}

async function withDb<T>(
  config: ResolvedConfig,
  use: (db: Awaited<ReturnType<typeof openHistoryDb>>) => T,
) {
  const db = await openHistoryDb(config.root, config.history.dir)
  try {
    return use(db)
  } finally {
    db.close()
  }
}

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()])
const limitField = (max: number, fallback: number, what: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`At most this many ${what} (default ${fallback}, at most ${max})`)

export const transcriptUri = (runId: string, attemptKey: string) =>
  `reeval://runs/${runId}/transcripts/${encodeURIComponent(attemptKey)}`

/** Reads the record of a run named by id, recorded or scratch; null if there's none. */
async function recordById(config: ResolvedConfig, runId: string): Promise<RunRecord | null> {
  if (!RUN_ID.test(runId)) return null
  const file = await resolveFile(source(config), { kind: 'record', runId })
  return file ? readRecord(file) : null
}

const INSTRUCTIONS = `Read-only access to this project's reeval run history: runs of evals for coding agents, recorded in git and scratch runs in .reeval/runs. Use it to debug a failed, flaky or regressed eval run.
Why did a run fail? Call failures first: each failed attempt's failing checks and judge scores, error, check logs and the end of its transcript, and whether its cell failed in earlier runs (new or not, since which run, what changed since it last passed). It's far smaller than show or summary.md.
Then: transcript reads one attempt in full; compare diffs two runs (regressions, fixes, stack changes); history is pass/fail per eval over recent runs; show is one run's whole record. The query_* tools answer questions across runs (flaky_cells, drift, failing_attempts, eval_trend, lift, effort); query runs read-only SQL (query_schema lists tables). analysis returns saved reeval analyze results. Runs are named latest, latest~N, a run id prefix or a git SHA prefix. Nothing here runs evals: reeval run does, in a terminal.`

/** Builds the factory `reeval mcp` serves: one McpServer per connection (stdio) or request (HTTP). */
export async function serverFactory(config: ResolvedConfig, version: string) {
  const columns = await viewColumns(config)
  return () => {
    const server = new McpServer(
      { name: 'reeval', title: 'reeval run history', version },
      { instructions: INSTRUCTIONS },
    )

    server.registerTool(
      'failures',
      {
        title: 'Why a run failed',
        description:
          'Debug a failed reeval eval run: why each failed or infra-error attempt failed. Per attempt: the failing expect checks with their messages, failed judge scores against thresholds, the error, nonzero check commands with their log tails, the setup log tail for infra errors, changed files, the final message and the last transcript lines (tool calls with targets and output). Per cell: whether the failure is new, the run its failing streak started in, the last run it passed and what changed since (fingerprint parts, eval source files). Start here, before show or transcript.',
        inputSchema: z.object({
          run: z.string().optional().describe(RUN_REF),
          filter: z.string().optional().describe('Only evals whose id contains this'),
          limit: limitField(100, DEFAULT_FAILURES, 'failed attempts'),
          tail: z
            .number()
            .int()
            .min(0)
            .max(100)
            .optional()
            .describe(`Transcript lines from the end of each attempt (default ${DEFAULT_TAIL})`),
        }),
        annotations: READ_ONLY,
      },
      guard(async ({ run, filter, limit, tail }) =>
        failuresView(config, { run, filter, limit, tail }),
      ),
    )

    server.registerTool(
      'history',
      {
        title: 'Run history',
        description:
          "Pass/fail of each reeval eval over recent runs, oldest first (reeval history --json, without each run's evals[], which show has): runs[] with their ids, commits and summaries, and rows[] with one outcome per run (null when not run) and drift, the runs where the eval or its stack changed. With no recorded runs it lists the scratch runs, with a note.",
        inputSchema: z.object({
          filter: z.string().optional().describe('Only evals whose id contains this'),
          limit: limitField(500, 20, 'runs'),
          all: z.boolean().optional().describe('Include scratch runs that were never recorded'),
        }),
        annotations: READ_ONLY,
      },
      guard(async ({ filter, limit, all }) => {
        const view = briefHistory(await historyView(config, { filter, limit, all }))
        if (all || view.runs.length) return view
        const scratch = briefHistory(await historyView(config, { filter, limit, all: true }))
        if (!scratch.runs.length) {
          return { ...view, note: 'No runs yet. reeval run, in a terminal, makes one.' }
        }
        return {
          ...scratch,
          note: 'No recorded runs yet, so these are the scratch runs in .reeval/runs (reeval run without --record). reeval run --record, or reeval record latest, records one.',
        }
      }),
    )

    server.registerTool(
      'show',
      {
        title: 'Show a run',
        description:
          'One reeval run: its full record (reeval show --json: stack, plan, evals, cells with lift and effort, attempts with verdicts, errors, token usage and file references) or, with format md, its summary.md. Large on big runs: to see why a run failed, failures is smaller.',
        inputSchema: z.object({
          run: z.string().optional().describe(RUN_REF),
          format: z.enum(['json', 'md']).optional().describe('json (default) or md'),
        }),
        annotations: READ_ONLY,
      },
      guard(async ({ run, format }) => {
        const record = await showRecord(config, run)
        return format === 'md'
          ? {
              runId: record.runId,
              markdown: renderSummary(record).trimEnd(),
            }
          : (record as Json)
      }),
    )

    server.registerTool(
      'compare',
      {
        title: 'Compare two runs',
        description:
          "Diffs two reeval runs eval by eval to find a regression (reeval compare --json): each changed row's base and head outcome and status (regressed, fixed, drift = not comparable, added, removed, infra), per-cell lift and effort, a row per pooled family with a minLift gate (kind: family), and what changed in the stack; same counts the unchanged evals, which all: true lists too. With only head, the base is head's nearest recorded ancestor.",
        inputSchema: z.object({
          base: z.string().optional().describe(`${RUN_REF}; needs head too`),
          head: z.string().optional().describe(RUN_REF),
          all: z.boolean().optional().describe('Also list the evals whose outcome is the same'),
        }),
        annotations: READ_ONLY,
      },
      guard(async ({ base, head, all }) => {
        const refs = base ? [base, head ?? 'latest'] : head ? [head] : []
        const { json } = await compareView(config, refs)
        if (all) return json as Json
        const rows = json.rows.filter((r) => r.status !== 'same')
        return { ...json, rows, same: json.rows.length - rows.length } as Json
      }),
    )

    server.registerTool(
      'analysis',
      {
        title: 'Saved analyses of a run',
        description:
          "The analyses reeval analyze saved for a run (in its history folder) and cached ones anchored on it, newest first: claims with citations, anomalies and suggested actions. Never calls a model; empty when the run hasn't been analysed.",
        inputSchema: z.object({ run: z.string().optional().describe(RUN_REF) }),
        annotations: READ_ONLY,
      },
      guard(async ({ run }) => {
        const entry = resolveRun(await allRuns(config), run)
        const { listAnalyses } = await import('../analysis/files.ts')
        const entries = await listAnalyses(config.root, [config.history.dir], entry.runId, true)
        return { runId: entry.runId, entries: sortAnalyses(entries) }
      }),
    )

    server.registerTool(
      'transcript',
      {
        title: 'Attempt transcript',
        description:
          "What the coding agent did in one reeval attempt, to debug it: its transcript.jsonl lines (prompts, messages, tool calls with inputs and outputs), a page at a time. Attempt keys are in show's evals[].attempts[].key.",
        inputSchema: z.object({
          run: z.string().optional().describe(RUN_REF),
          attempt: z
            .string()
            .describe('The attempt key, or its id (<cell>#<n>) when only one eval has it'),
          offset: z.number().int().min(0).optional().describe('Lines to skip (default 0)'),
          limit: limitField(MAX_ROWS, DEFAULT_LINES, 'lines'),
        }),
        annotations: READ_ONLY,
      },
      guard(async ({ run, attempt, offset = 0, limit = DEFAULT_LINES }) => {
        const record = await showRecord(config, run)
        const read = await readTranscript(config, record, attempt)
        return {
          runId: record.runId,
          attempt: read.attempt.key,
          uri: transcriptUri(record.runId, read.attempt.key),
          total: read.lines.length,
          offset,
          lines: read.lines.slice(offset, offset + limit),
        }
      }),
    )

    for (const view of VIEW_NAMES) {
      const cols = columns[view] ?? []
      const where = z
        .strictObject(Object.fromEntries(cols.map((c) => [c, cell.optional()])))
        .optional()
        .describe('Only rows where each named column equals its value (null matches NULL)')
      server.registerTool(
        `query_${view}`,
        {
          title: `Query ${view}`,
          description: `The ${view} view of reeval query, over the eval run history: one row per ${VIEW_ROWS[view] ?? 'row'}. Columns: ${cols.join(', ')}.`,
          inputSchema: z.object({ where, limit: limitField(MAX_ROWS, DEFAULT_ROWS, 'rows') }),
          annotations: READ_ONLY,
        },
        guard(async ({ where, limit = DEFAULT_ROWS }) => {
          const filters = Object.entries(where ?? {}).filter(([, v]) => v !== undefined)
          const sql = `SELECT * FROM "${view}"${filters.length ? ` WHERE ${filters.map(([c]) => `"${c}" IS ?`).join(' AND ')}` : ''} LIMIT ?`
          const params = filters.map(([, v]) => (typeof v === 'boolean' ? Number(v) : v)) as Array<
            string | number | null
          >
          return withDb(config, (db) => {
            const found = db.query(sql, [...params, limit + 1])
            // Without StatementSync#columns (Node < 22.16), an empty result has no columns.
            return rowsOf({ ...found, columns: found.columns.length ? found.columns : cols }, limit)
          })
        }),
      )
    }

    server.registerTool(
      'query',
      {
        title: 'Query run history with SQL',
        description:
          "One read-only SQLite SELECT or WITH statement over .reeval/history.db, the projection of every recorded and scratch run (reeval query). Tables include runs, evals, cells, attempts, judgements, tool_calls, assertions; the views are the query_* tools. query_schema lists every table's columns.",
        inputSchema: z.object({
          sql: z.string().describe('One SELECT or WITH statement'),
          limit: limitField(MAX_ROWS, DEFAULT_ROWS, 'rows'),
        }),
        annotations: READ_ONLY,
      },
      guard(async ({ sql, limit = DEFAULT_ROWS }) => {
        const problem = sqlProblem(sql)
        if (problem) throw new Error(problem)
        return withDb(config, (db) => rowsOf(db.query(sql), limit))
      }),
    )

    server.registerTool(
      'query_schema',
      {
        title: 'History tables and views',
        description:
          'Every table and view in .reeval/history.db with its columns (reeval query --schema --json), for the query tool.',
        annotations: READ_ONLY,
      },
      guard(async () => withDb(config, (db) => ({ objects: db.schema() }))),
    )

    server.registerResource(
      'run',
      new ResourceTemplate('reeval://runs/{runId}', {
        list: async () => {
          const { listHeaders } = await import('../studio/source.ts')
          const runs = await listHeaders(source(config))
          return {
            resources: [...runs].reverse().map((r) => ({
              uri: `reeval://runs/${r.runId}`,
              name: r.runId,
              title: `${r.runId} (${r.recorded ? 'recorded' : 'scratch'})`,
              mimeType: 'application/json',
            })),
          }
        },
      }),
      {
        title: 'Run record',
        description: 'A run record, as reeval show --json prints it',
        mimeType: 'application/json',
        cacheHint: { ttlMs: 0, cacheScope: 'private' },
      },
      async (uri, { runId }) => {
        const record = await recordById(config, String(runId))
        if (!record) throw new Error(`No run ${String(runId)}`)
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: redactJson(record, 2),
            },
          ],
        }
      },
    )

    server.registerResource(
      'transcript',
      new ResourceTemplate('reeval://runs/{runId}/transcripts/{attempt}', { list: undefined }),
      {
        title: 'Attempt transcript',
        description:
          "An attempt's transcript.jsonl; the attempt key is percent-encoded (the transcript tool returns the URI)",
        mimeType: 'application/jsonl',
        cacheHint: { ttlMs: 0, cacheScope: 'private' },
      },
      async (uri, { runId, attempt }) => {
        const record = await recordById(config, String(runId))
        if (!record) throw new Error(`No run ${String(runId)}`)
        const read = await readTranscript(config, record, decode(String(attempt)))
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/jsonl',
              text: read.lines.map((l) => redactJson(l)).join('\n'),
            },
          ],
        }
      },
    )

    return server
  }
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * History without each run's evals[], which repeat rows[] with every cell's fingerprint and sources:
 * kilobytes a run, and some MCP clients show a long tool result as empty.
 */
function briefHistory<V extends { runs: { evals: unknown }[] }>(view: V) {
  return { ...view, runs: view.runs.map(({ evals: _, ...run }) => run) }
}

function rowsOf(result: { columns: string[]; rows: Json[] }, limit: number) {
  return {
    columns: result.columns,
    rows: result.rows.slice(0, limit),
    truncated: result.rows.length > limit,
  }
}
