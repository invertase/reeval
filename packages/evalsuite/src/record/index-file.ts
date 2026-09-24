import type { StoreReader } from '../store/types.ts'
import {
  type IndexEntry,
  type RunIndex,
  type RunRecord,
  SCHEMA_VERSION,
  type TrialRecord,
} from './types.ts'

export const INDEX_PATH = 'index.json'
export const README_PATH = 'README.md'
const RUN_JSON = /^runs\/\d{4}\/\d{2}\/[^/]+\/run\.json$/

export class SchemaError extends Error {
  override name = 'SchemaError'
}

const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')
export const encodeJson = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

function checkVersion(
  value: { schemaVersion?: unknown; kind?: unknown },
  kind: string,
  where: string,
) {
  if (value.kind !== kind) throw new SchemaError(`${where} is not an ES ${kind} file`)
  if (value.schemaVersion !== SCHEMA_VERSION) {
    const v = Number(value.schemaVersion)
    throw new SchemaError(
      v > SCHEMA_VERSION
        ? `${where} was written by a newer ES (schema ${v}); upgrade evalsuite to read it`
        : `${where} has schema ${String(value.schemaVersion)}; this ES reads ${SCHEMA_VERSION}`,
    )
  }
}

export function parseRun(bytes: Uint8Array, where: string): RunRecord {
  const value = JSON.parse(decode(bytes)) as RunRecord
  checkVersion(value, 'es-run', where)
  return value
}

export function parseTrial(bytes: Uint8Array, where: string): TrialRecord {
  const value = JSON.parse(decode(bytes)) as TrialRecord
  checkVersion(value, 'es-trial', where)
  return value
}

/** A usable index, or null when it's missing, unreadable or from another schema. */
export function parseIndex(bytes: Uint8Array | null): RunIndex | null {
  if (!bytes) return null
  try {
    const value = JSON.parse(decode(bytes)) as RunIndex
    return value.kind === 'es-index' && value.schemaVersion === SCHEMA_VERSION ? value : null
  } catch {
    return null
  }
}

export function indexEntry(run: RunRecord, path: string): IndexEntry {
  return {
    runId: run.runId,
    path,
    status: run.status,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    git: run.git
      ? {
          sha: run.git.sha,
          branch: run.git.branch,
          dirty: run.git.dirty,
          commitTime: run.git.commitTime,
        }
      : null,
    runner: run.runner.kind,
    harness: run.config.harness,
    model: run.config.model,
    judgeModel: run.config.judgeModel,
    summary: run.summary,
    evals: run.evals.map((e) => ({ id: e.id, fingerprint: e.fingerprint, outcome: e.outcome })),
  }
}

/**
 * Derives the index from the records in `view`. Entries from `previous` are reused for runs
 * that are still present, so only new runs are read; `previous: null` reads every record.
 * The output depends only on the records, so two publishers produce identical bytes.
 */
export async function buildIndex(view: StoreReader, previous: RunIndex | null): Promise<RunIndex> {
  const known = new Map((previous?.runs ?? []).map((e) => [e.path, e]))
  const paths = (await view.list('runs/')).filter((p) => RUN_JSON.test(p))
  const runs: IndexEntry[] = []
  for (const path of paths) {
    const cached = known.get(path)
    if (cached) {
      runs.push(cached)
      continue
    }
    const bytes = await view.get(path)
    if (!bytes) continue
    try {
      runs.push(indexEntry(parseRun(bytes, path), path))
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error
    }
  }
  runs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
  return { kind: 'es-index', schemaVersion: SCHEMA_VERSION, runs }
}

export const STORE_README = `# ES results

Run history written by ES (\`evalsuite\`, CLI \`es\`). Every file here is
plain text. Runs are immutable; \`index.json\` and this README are regenerated on every publish.
Layout schema version: ${SCHEMA_VERSION}.

## Layout

\`\`\`
index.json                         one entry per run, sorted by runId (derived)
runs/<yyyy>/<mm>/<runId>/
  run.json                         the record: git, runner, versions, config, every eval's outcome
  summary.md                       the same run as Markdown, failures first-class
  evals/<slug>/<trial>/
    result.json                    outcome, error, judge scores, checks, file refs
    transcript.jsonl               one event per line: prompt, text, tool-call, tool-result, turn-end
    final.md                       the agent's final message for each turn
    diff.patch                     workspace changes (applies with git apply)
    judge-input.json               exactly what each judge call saw
    checks/<n>.log                 command, exit code, stdout, stderr of each t.exec
    tool-output/<seq>.txt          tool outputs too big to inline in the transcript
\`\`\`

Run ids (\`20260924T152700Z-3f9k2m7q\`) sort by UTC start time. An eval's \`slug\` is its id,
slugified, plus a hash; \`run.json\` maps ids to slugs.

## Finding things

\`\`\`sh
es history                                  # pass/fail per eval over recent runs
es show latest --md                         # summary.md of the newest run
es compare                                  # newest run against its baseline
rg -l '"outcome": "fail"' runs --glob result.json
rg -g transcript.jsonl 'ENOENT' runs/2026/09
\`\`\`

Results compare only when an eval's \`fingerprint\` matches (eval source, harness, agent CLI,
image, judge). Judge scores are probabilities; \`reason\` is null for evaluation-model judges.
`

/** The derive step every commit uses: index plus README. */
export async function deriveStore(view: StoreReader): Promise<Map<string, Uint8Array>> {
  const index = await buildIndex(view, parseIndex(await view.get(INDEX_PATH)))
  return new Map([
    [INDEX_PATH, encodeJson(index)],
    [README_PATH, Buffer.from(STORE_README)],
  ])
}
