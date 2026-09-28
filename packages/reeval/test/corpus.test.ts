// Every reader against every run in the record corpus (test/fixtures/records/), so a record reeval
// wrote at any point since keeps loading in the CLI. The studio's browser test opens the same runs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { RunRecord } from '../src/history/types.ts'
import { readableRecord } from '../src/view/record.ts'
import { runCli } from './helpers.ts'
import { corpusEntries } from './support/corpus.ts'
import { fixture } from './support/fixture.ts'

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

  for (const entry of entries) {
    test(`${entry.name}: every CLI reader reads every run`, async () => {
      const p = await fixture(`fixtures/records/${entry.name}`)
      const ok = async (args: string[], codes = [0]) => {
        const r = await runCli(p.dir, args, { timeoutMs: 120_000 })
        const where = `reeval ${args.join(' ')} in ${entry.name}\n${r.stdout}${r.stderr}`
        assert.ok(codes.includes(r.code as number), where)
        assert.doesNotMatch(r.stderr, /warning: skipped|TypeError|Cannot read prop/, where)
        return r.stdout
      }
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
        await ok(['show', run.runId])
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
