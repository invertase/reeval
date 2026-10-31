// Every reader against every run in the record corpus (test/fixtures/records/), so a record reeval
// wrote at any point since keeps loading in the CLI. Every entry's runs go into one history: the
// commands that read all of it (history, query, studio build) run once, through the CLI, and the
// per-run ones (show, compare, analyze) run in this process for every run, since a CLI start each
// would be most of the suite's time. The studio's browser test opens the same runs.
import assert from 'node:assert/strict'
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { analyzeCommand } from '../src/analysis/command.ts'
import { compareCommand, showCommand } from '../src/commands.ts'
import { loadConfig } from '../src/config.ts'
import type { RunRecord } from '../src/history/types.ts'
import { queryCommand } from '../src/query.ts'
import { countSecrets } from '../src/redact.ts'
import type { ResolvedConfig } from '../src/types.ts'
import { readableRecord } from '../src/view/record.ts'
import { project, runCli } from './helpers.ts'
import { CORPUS_DIR, corpusEntries, HISTORY_DIR } from './support/corpus.ts'
import { REAL_HARNESSES, realAttempts } from './support/real-runs.ts'

const entries = corpusEntries()

/** What the corpus as a whole has to hold, so every part of a record is read by some test. */
const REQUIRED = [
  'compare with lift',
  'pooled family',
  'judge pass',
  'judge fail',
  'outcome fail',
  'outcome infra_error',
  'outcome skipped',
  'todo',
  'status budget',
  'saved analysis',
  'transcript',
  'diff',
  'tokens',
  'harness cursor',
  'harness claude-code',
  'harness antigravity',
  'harness opencode',
  'harness goose',
  'harness pi',
  'harness codex',
  'before plan.sandboxWarnings',
  'before the reeval sandbox user',
]

function covers(record: RunRecord, raw: Record<string, unknown>, hasAnalysis: boolean): string[] {
  const out = new Set<string>()
  const attempts = record.evals.flatMap((e) => e.attempts)
  if (record.evals.some((e) => e.cells.some((c) => c.lift))) out.add('compare with lift')
  if (record.families?.some((f) => f.lifts.length)) out.add('pooled family')
  for (const a of attempts) {
    for (const j of a.judgements) out.add(`judge ${j.verdict}`)
    out.add(`outcome ${a.outcome}`)
    if (a.files.transcript) out.add('transcript')
    if (a.files.diff) out.add('diff')
    if (a.usage) out.add('tokens')
  }
  for (const e of record.evals) {
    out.add(`outcome ${e.outcome}`)
    if (e.todo) out.add('todo')
  }
  out.add(`status ${record.status}`)
  for (const h of record.stack.harnesses) out.add(`harness ${h.kind}`)
  if (hasAnalysis) out.add('saved analysis')
  if (!('sandboxWarnings' in (raw.plan as object))) out.add('before plan.sandboxWarnings')
  if (JSON.stringify(raw).includes('/es/workspace/')) out.add('before the reeval sandbox user')
  return [...out]
}

const ALL_IDS = entries.flatMap((e) => e.runs.map((r) => r.runId)).sort()

/** Rows `reeval show` prints for every run, whatever reeval wrote it. */
const STATE_ROWS = [
  'Executed at',
  'Lockfiles',
  'Images',
  'Harnesses',
  'Environments',
  'Judge',
  'Context',
  'Packages',
  'reeval',
  'Runner',
]

type QuerySchema = Array<{ name: string; type: 'table' | 'view' }>
type Out = (s: string) => void
const statement = (s: QuerySchema[number]) =>
  s.type === 'view' ? s.name : `select * from ${s.name}`

/** Output no reader may print, whatever the record's age. */
function clean(where: string, stdout: string, stderr: string) {
  assert.doesNotMatch(stderr, /warning: skipped|TypeError|Cannot read prop/, `${where}\n${stderr}`)
  assert.doesNotMatch(
    stdout,
    /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/,
    `${where}\n${stdout}`,
  )
}

/**
 * Runs a command in this process and returns its stdout, after checking it printed nothing odd.
 * The readers that skip an unreadable file warn on `process.stderr`, not on `err`, so that's
 * captured too.
 */
async function capture(
  command: (out: Out, err: Out) => Promise<number>,
  where = 'reeval',
  codes = [0],
): Promise<string> {
  let stdout = ''
  let stderr = ''
  const write = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  let code: number
  try {
    code = await command(
      (text) => (stdout += `${text}\n`),
      (text) => (stderr += `${text}\n`),
    )
  } finally {
    process.stderr.write = write
  }
  clean(where, stdout, stderr)
  assert.ok(codes.includes(code), `${where} exited ${code}\n${stdout}${stderr}`)
  return stdout
}

/**
 * One project whose history holds every entry's runs, so each reader that reads the whole history
 * (`history`, `query`, `studio build`) reads every run at once, across every reeval that wrote one.
 */
async function mergedProject(name: string) {
  const p = await project(name, { 'reeval.config.ts': CONFIG })
  for (const e of entries)
    cpSync(join(e.dir, HISTORY_DIR), join(p.dir, HISTORY_DIR), { recursive: true })
  return p
}

/**
 * The merged history for the readers this process runs. It's a copy of its own: this process's
 * build id differs from dist's, and the history cache each keeps is keyed on it.
 */
let shared: Promise<{ config: ResolvedConfig }> | undefined
const inProcess = () =>
  (shared ??= mergedProject('corpus-in-process').then(async (p) => ({
    config: await loadConfig(join(p.dir, 'reeval.config.ts'), 'show'),
  })))

/** The corpus's own config: the fake harness, and an analysis model for `reeval analyze`. */
const CONFIG = `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness(),
  environments: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  analysis: {
    model: fakeAnalysis({
      output: () => ({
        tldr: 'corpus',
        whatHappened: [],
        results: [],
        why: [],
        anomalies: [],
        actions: [],
        confidence: { overall: 'low', why: 'corpus' },
      }),
    }),
  },
})
`

describe('the record corpus', { concurrency: 4 }, () => {
  test('holds every kind of run the record can describe', () => {
    const found = new Set(
      entries.flatMap((e) =>
        e.runs.flatMap((r) =>
          covers(readableRecord(structuredClone(r.raw) as never), r.raw, r.analyses > 0),
        ),
      ),
    )
    const missing = REQUIRED.filter((k) => !found.has(k))
    assert.deepEqual(missing, [], 'add a corpus entry that has them (scripts/corpus/add.ts)')
  })

  test('holds nothing that looks like a key', () => {
    // Beyond reeval's own token shapes: Cursor's API keys.
    const CURSOR_KEY = /\b(?:crsr_[A-Za-z0-9]{20,}|key_[0-9a-f]{32,})/g
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name)
        if (e.isDirectory()) walk(path)
        else {
          const text = readFileSync(path, 'utf8')
          const n = countSecrets(text, {}) + (text.match(CURSOR_KEY)?.length ?? 0)
          if (n) hits.push(`${relative(CORPUS_DIR, path)}: ${n}`)
        }
      }
    }
    walk(CORPUS_DIR)
    assert.deepEqual(hits, [])
  })

  test('real-harness runs have the transcripts and diffs later readers use', () => {
    const attempts = realAttempts()
    for (const harness of REAL_HARNESSES) {
      const e2e = attempts.filter((a) => a.entry === 'real-e2e-pairs' && a.harness === harness)
      assert.equal(new Set(e2e.map((a) => a.runId)).size, 2, `${harness}: two e2e runs`)
      const contract = attempts.filter((a) => a.entry === 'real-contract' && a.harness === harness)
      assert.equal(new Set(contract.map((a) => a.runId)).size, 1, `${harness}: one contract run`)
      assert.ok(
        contract.some((a) => a.attempt.outcome === 'fail'),
        `${harness}: a canary fails`,
      )
      const agent = [...e2e, ...contract].filter((a) => a.attempt.turns.length)
      assert.ok(agent.length >= 8, `${harness}: e2e and contract attempts that reached the agent`)
      for (const a of agent) {
        const where = `${a.entry} ${a.runId} ${a.attempt.key}`
        assert.equal(a.attempt.outcome, 'pass', where)
        assert.ok(a.transcript && existsSync(a.transcript), `${where}: transcript`)
        assert.ok(a.diff && existsSync(a.diff), `${where}: diff`)
      }
    }
  })

  test('every CLI command reads the merged history', async () => {
    const p = await mergedProject('corpus-cli')
    const ok = async (args: string[], codes = [0]) => {
      const r = await runCli(p.dir, args, { timeoutMs: 120_000 })
      clean(`reeval ${args.join(' ')}`, r.stdout, r.stderr)
      assert.ok(
        codes.includes(r.code as number),
        `reeval ${args.join(' ')}\n${r.stdout}${r.stderr}`,
      )
      return r.stdout
    }
    const listed = JSON.parse(
      await ok(['history', '--json', '--all', '--limit', String(ALL_IDS.length)]),
    ) as {
      runs: Array<{ runId: string }>
    }
    assert.deepEqual(
      listed.runs.map((r) => r.runId).sort(),
      ALL_IDS,
      'reeval history lists every run',
    )
    await ok(['history'])
    // The per-run readers run in this process below; here each runs once through the CLI, on the
    // oldest run and on the newest.
    for (const id of [ALL_IDS[0], ALL_IDS.at(-1)] as string[]) {
      await ok(['show', id])
      await ok(['show', id, '--md'])
      await ok(['show', id, '--json'])
      await ok(['compare', id], [0, 1])
      await ok(['analyze', id, '--dry-run'])
    }
    await ok(['compare', ALL_IDS[0] as string, ALL_IDS.at(-1) as string, '--md'], [0, 1])
    const schema = JSON.parse(await ok(['query', '--schema', '--json'])) as QuerySchema
    for (const type of ['view', 'table']) {
      const q = statement(schema.find((s) => s.type === type) as QuerySchema[number])
      await ok(['query', q])
      await ok(['query', q, '--json'])
    }
    await ok(['query', '--rebuild', 'select count(*) as n from runs'])
    const site = join(p.dir, 'site')
    await ok(['studio', 'build', '--out', site])
    for (const id of ALL_IDS) readFileSync(join(site, 'data/runs', `${id}.json`))
  })

  // One at a time: a history sync holds SQLite's write lock across awaits, and a second sync in
  // the same process waits for it synchronously, so the first never gets to finish.
  describe('in this process', { concurrency: 1 }, () => {
    test('every view and table of reeval query, in both formats, over the merged history', async () => {
      const { config } = await inProcess()
      const schema = JSON.parse(
        await capture((out, err) =>
          queryCommand({ config, flags: { schema: true, json: true }, out, err }, []),
        ),
      ) as QuerySchema
      for (const s of schema) {
        for (const json of [false, true]) {
          await capture(
            (out, err) => queryCommand({ config, flags: { json }, out, err }, [statement(s)]),
            `reeval query ${statement(s)}${json ? ' --json' : ''}`,
          )
        }
      }
    })

    for (const entry of entries) {
      test(`${entry.name}: every reader reads every run`, async () => {
        const { config } = await inProcess()
        const ids = entry.runs.map((r) => r.runId)
        const run = (
          where: string,
          command: (out: Out, err: Out) => Promise<number>,
          codes?: number[],
        ) => capture(command, `${where} in ${entry.name}`, codes)
        for (const [i, r] of entry.runs.entries()) {
          const id = r.runId
          const vs = ids[i - 1] ?? 'none'
          const text = await run(`reeval show ${id}`, (out) =>
            showCommand({ config, flags: {}, out }, [id]),
          )
          for (const row of STATE_ROWS)
            assert.match(text, new RegExp(`\\n {2}${row} +\\S`), `${entry.name} ${id}: ${row}`)
          await run(`reeval show ${id} --md`, (out) =>
            showCommand({ config, flags: { md: true }, out }, [id]),
          )
          const shown = JSON.parse(
            await run(`reeval show ${id} --json`, (out) =>
              showCommand({ config, flags: { json: true }, out }, [id]),
            ),
          )
          assert.deepEqual(shown, readableRecord(structuredClone(r.raw) as never))
          await run(
            `reeval compare ${id}`,
            (out) => compareCommand({ config, flags: {}, out }, [id]),
            [0, 1],
          )
          await run(`reeval analyze ${id} --dry-run --vs ${vs}`, (out, err) =>
            analyzeCommand({ config, flags: { 'dry-run': true, vs }, out, err }, [id]),
          )
          if (r.analyses)
            assert.match(
              await run(`reeval analyze ${id} --json --vs ${vs}`, (out, err) =>
                analyzeCommand({ config, flags: { json: true, vs }, out, err }, [id]),
              ),
              /"kind": "reeval-analysis"/,
            )
        }
        for (const [i, id] of ids.entries()) {
          if (i === 0) continue
          for (const flags of [{}, { json: true }, { md: true }]) {
            await run(
              `reeval compare ${ids[i - 1]} ${id} ${JSON.stringify(flags)}`,
              (out) => compareCommand({ config, flags, out }, [ids[i - 1] as string, id]),
              [0, 1],
            )
          }
        }
      })
    }
  })
})
