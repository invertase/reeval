// `reeval mcp`'s server: run history as read-only MCP tools and resources. The same factory serves
// stdio and each stateless HTTP request, so it builds a fresh McpServer and holds nothing.
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { allRuns, compareView, historyView, showRecord } from '../commands.ts'
import { openHistoryDb, VIEW_NAMES } from '../history/db.ts'
import { readRecord } from '../history/files.ts'
import { withOverrides } from '../history/overrides.ts'
import { renderSummary } from '../history/summary.ts'
import type { RunRecord } from '../history/types.ts'
import { resolveRun } from '../history/views.ts'
import { statementCount } from '../query.ts'
import { redactSecrets } from '../redact.ts'
import { resolveFile, type StudioSource } from '../studio/source.ts'
import type { ResolvedConfig } from '../types.ts'
import { sortAnalyses } from '../view/analysis.ts'
import type { TranscriptLine } from '../view/model.ts'
import { RUN_ID } from '../view/paths.ts'
import { readableTranscriptLine } from '../view/record.ts'

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
  const text = redactSecrets(JSON.stringify(value, null, 2))
  let structured: Json
  try {
    structured = JSON.parse(text) as Json
  } catch {
    structured = { text }
  }
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

const source = (config: ResolvedConfig): StudioSource => ({
  root: config.root,
  historyDir: config.history.dir,
  scratch: true,
})

export const transcriptUri = (runId: string, attemptKey: string) =>
  `reeval://runs/${runId}/transcripts/${encodeURIComponent(attemptKey)}`

/** The attempt `ref` names in `run`: its key, or an attempt id (`<cell>#<n>`) unique in the run. */
function findAttempt(run: RunRecord, ref: string) {
  const attempts = run.evals.flatMap((e) => e.attempts)
  const exact = attempts.find((a) => a.key === ref)
  if (exact) return exact
  const byId = attempts.filter((a) => a.id === ref)
  if (byId.length === 1 && byId[0]) return byId[0]
  const keys = attempts.map((a) => a.key)
  const listed = `${keys.slice(0, 20).join('; ')}${keys.length > 20 ? `; … ${keys.length - 20} more` : ''}`
  throw new Error(
    byId.length > 1
      ? `"${ref}" is an attempt of ${byId.length} evals in ${run.runId}; use its key: ${byId.map((a) => a.key).join('; ')}`
      : `No attempt "${ref}" in ${run.runId}. Attempts: ${listed}`,
  )
}

async function readTranscript(config: ResolvedConfig, run: RunRecord, ref: string) {
  const attempt = findAttempt(run, ref)
  const path = attempt.files.transcript?.path
  const file =
    path &&
    (await resolveFile(source(config), {
      kind: 'artifact',
      runId: run.runId,
      segments: path.split('/'),
    }))
  if (!file) {
    throw new Error(
      `${run.runId} kept no transcript for ${attempt.key} (recorded with --artifacts failures or none?)`,
    )
  }
  const lines: TranscriptLine[] = []
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try {
      lines.push(readableTranscriptLine(JSON.parse(line) as TranscriptLine))
    } catch {}
  }
  return { attempt, lines }
}

/** Reads the record of a run named by id, recorded or scratch; null if there's none. */
async function recordById(config: ResolvedConfig, runId: string): Promise<RunRecord | null> {
  if (!RUN_ID.test(runId)) return null
  const file = await resolveFile(source(config), { kind: 'record', runId })
  return file ? withOverrides(await readRecord(file), dirname(file)) : null
}

const INSTRUCTIONS = `Read-only access to this project's reeval run history: runs of evals for coding agents, recorded in git and scratch runs in .reeval/runs.
Start with history (pass/fail per eval over recent runs) or show (one run). compare diffs two runs (regressions, fixes, stack changes). The query_* tools answer common questions across runs (lift, flaky cells, drift, failures); query runs any read-only SQL (query_schema lists tables and columns). transcript reads what an agent did in one attempt. analysis returns saved reeval analyze results. Runs are named latest, latest~N, a run id prefix or a git SHA prefix. Nothing here runs evals: that's reeval run in a terminal.`

/** Builds the factory `reeval mcp` serves: one McpServer per connection (stdio) or request (HTTP). */
export async function serverFactory(config: ResolvedConfig, version: string) {
  const columns = await viewColumns(config)
  return () => {
    const server = new McpServer(
      { name: 'reeval', title: 'reeval run history', version },
      { instructions: INSTRUCTIONS },
    )

    server.registerTool(
      'history',
      {
        title: 'Run history',
        description:
          'Pass/fail of each eval over recent runs, oldest first (reeval history --json): runs[] with their ids, commits and summaries, and rows[] with one outcome per run (null when not run) and drift, the runs where the eval or its stack changed.',
        inputSchema: z.object({
          filter: z.string().optional().describe('Only evals whose id contains this'),
          limit: limitField(500, 20, 'runs'),
          all: z.boolean().optional().describe('Include scratch runs that were never recorded'),
        }),
        annotations: READ_ONLY,
      },
      guard(async ({ filter, limit, all }) => historyView(config, { filter, limit, all })),
    )

    server.registerTool(
      'show',
      {
        title: 'Show a run',
        description:
          'One run: its full record (reeval show --json: stack, plan, evals, cells with lift and effort, attempts with verdicts, errors, token usage and file references) or, with format md, its summary.md.',
        inputSchema: z.object({
          run: z.string().optional().describe(RUN_REF),
          format: z.enum(['json', 'md']).optional().describe('json (default) or md'),
        }),
        annotations: READ_ONLY,
      },
      guard(async ({ run, format }) => {
        const record = await showRecord(config, run)
        return format === 'md'
          ? { runId: record.runId, markdown: renderSummary(record).trimEnd() }
          : (record as unknown as Json)
      }),
    )

    server.registerTool(
      'compare',
      {
        title: 'Compare two runs',
        description:
          "Diffs two runs eval by eval (reeval compare --json): each row's base and head outcome and status (regressed, fixed, same, drift = not comparable, added, removed, infra), per-cell lift and effort, and what changed in the stack. With only head, the base is head's nearest recorded ancestor.",
        inputSchema: z.object({
          base: z.string().optional().describe(`${RUN_REF}; needs head too`),
          head: z.string().optional().describe(RUN_REF),
        }),
        annotations: READ_ONLY,
      },
      guard(async ({ base, head }) => {
        const refs = base ? [base, head ?? 'latest'] : head ? [head] : []
        return (await compareView(config, refs)).json as Json
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
          "What the agent did in one attempt: its transcript.jsonl lines (prompts, messages, tool calls with inputs and outputs), a page at a time. Attempt keys are in show's evals[].attempts[].key.",
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
          description: `The ${view} view of reeval query: one row per ${VIEW_ROWS[view] ?? 'row'}. Columns: ${cols.join(', ')}.`,
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
              text: redactSecrets(JSON.stringify(record, null, 2)),
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
              text: redactSecrets(read.lines.map((l) => JSON.stringify(l)).join('\n')),
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

function rowsOf(result: { columns: string[]; rows: Json[] }, limit: number) {
  return {
    columns: result.columns,
    rows: result.rows.slice(0, limit),
    truncated: result.rows.length > limit,
  }
}
