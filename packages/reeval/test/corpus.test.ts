// Every reader against every run in the record corpus (test/fixtures/records/), so a record reeval
// wrote at any point since keeps loading in the CLI. The studio's browser test opens the same runs.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import type { RunRecord } from '../src/history/types.ts'
import { countSecrets } from '../src/redact.ts'
import { readableRecord } from '../src/view/record.ts'
import { runCli } from './helpers.ts'
import { CORPUS_DIR, corpusEntries } from './support/corpus.ts'
import { fixture } from './support/fixture.ts'
import { REAL_HARNESSES, realAttempts } from './support/real-runs.ts'

const entries = corpusEntries()

/** What the corpus as a whole has to hold, so every part of a record is read by some test. */
const REQUIRED = [
  'compare with lift',
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
  // Sandboxes ran as `es` in /es/workspace until the rename; those paths are opaque strings now.
  if (JSON.stringify(raw).includes('/es/workspace/')) out.add('before the reeval sandbox user')
  return [...out]
}

describe('the record corpus', () => {
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

  for (const entry of entries) {
    test(`${entry.name}: every CLI reader reads every run`, async () => {
      const p = await fixture(`fixtures/records/${entry.name}`)
      const ok = async (args: string[], codes = [0]) => {
        const r = await runCli(p.dir, args, { timeoutMs: 120_000 })
        const where = `reeval ${args.join(' ')} in ${entry.name}\n${r.stdout}${r.stderr}`
        assert.ok(codes.includes(r.code as number), where)
        assert.doesNotMatch(r.stderr, /warning: skipped|TypeError|Cannot read prop/, where)
        assert.doesNotMatch(r.stdout, /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/, where)
        return r.stdout
      }
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
      const ids = entry.runs.map((r) => r.runId)
      const listed = JSON.parse(await ok(['history', '--json', '--all'])) as {
        runs: Array<{ runId: string }>
      }
      assert.deepEqual(
        listed.runs.map((r) => r.runId).sort(),
        ids,
        'reeval history lists every run',
      )
      await ok(['history'])
      for (const run of entry.runs) {
        const text = await ok(['show', run.runId])
        for (const row of STATE_ROWS)
          assert.match(text, new RegExp(`\\n {2}${row} +\\S`), `${entry.name} ${run.runId}: ${row}`)
        await ok(['show', run.runId, '--md'])
        const shown = JSON.parse(await ok(['show', run.runId, '--json']))
        assert.deepEqual(shown, readableRecord(structuredClone(run.raw) as never))
        await ok(['compare', run.runId], [0, 1])
        await ok(['analyze', run.runId, '--dry-run'])
        if (run.analyses)
          assert.match(await ok(['analyze', run.runId, '--json']), /"kind": "es-analysis"/)
      }
      for (const [i, id] of ids.entries()) {
        if (i === 0) continue
        for (const flag of [[], ['--json'], ['--md']]) {
          await ok(['compare', ids[i - 1] as string, id, ...flag], [0, 1])
        }
      }
      const schema = JSON.parse(await ok(['query', '--schema', '--json'])) as Array<{
        name: string
        type: 'table' | 'view'
      }>
      for (const s of schema) {
        const q = s.type === 'view' ? s.name : `select * from ${s.name}`
        await ok(['query', q])
        await ok(['query', q, '--json'])
      }
      await ok(['query', '--rebuild', 'select count(*) as n from runs'])
      const site = join(p.dir, 'site')
      await ok(['studio', 'build', '--out', site])
      for (const id of ids) readFileSync(join(site, 'data/runs', `${id}.json`))
    })
  }
})
