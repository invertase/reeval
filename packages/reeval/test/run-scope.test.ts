import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { corpus, corpusEntries } from '../scripts/schema/corpus.ts'
import type { RunInvocation, RunRecord } from '../src/history/types.ts'
import { runReportMarkdown } from '../src/renderer/markdown.ts'
import { runHeader } from '../src/view/header.ts'
import { readableRecord } from '../src/view/record.ts'
import { buildRunReport, runReportSchema } from '../src/view/report/index.ts'
import { runScope } from '../src/view/scope.ts'
import { sha256Hex } from '../src/view/sha256.ts'

type Scoped = RunRecord & {
  profile: NonNullable<RunRecord['profile']>
  invocation: RunInvocation
}

function base(): Scoped {
  const file = corpusEntries()
    .find((e) => e.name === 'fake-matrix')
    ?.runs.at(-1)?.file
  assert.ok(file, 'fake-matrix has a run')
  const record = readableRecord(JSON.parse(readFileSync(file, 'utf8')) as RunRecord)
  return {
    ...record,
    profile: {
      name: 'smoke',
      reason: '--profile',
      defaults: { harness: ['a', 'b'], runs: 2 },
      limit: { harness: ['a', 'b'], traits: { os: ['linux', 'mac'] } },
    },
    invocation: { profile: 'smoke', filters: [], tags: [] },
  }
}

const edited = (edit: (r: Scoped) => void): RunRecord => {
  const r = base()
  edit(r)
  return r
}

const key = (r: RunRecord) => runScope(r).configKey

describe('sha256Hex', () => {
  test('matches the FIPS 180-4 test vectors', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(
      sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    assert.equal(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    assert.equal(
      sha256Hex('a'.repeat(1_000_000)),
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })

  test('matches node:crypto across block boundaries and UTF-8, and on bytes', () => {
    for (let n = 0; n <= 200; n++) {
      const text = 'ä€😀x'.repeat(n).slice(0, n)
      assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'), `length ${n}`)
    }
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff)
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'))
  })
})

describe('runScope', () => {
  test('the same config with other evals, author, git, time or concurrency keeps the key', () => {
    const k = key(base())
    assert.match(k, /^[0-9a-f]{64}$/)
    assert.equal(key(edited((r) => r.evals.pop())), k)
    assert.equal(
      key(
        edited((r) => {
          r.author = 'someone-else'
          r.git = null
          r.startedAt = '2030-01-01T00:00:00.000Z'
          r.config.concurrency = 16
          r.invocation = { ...r.invocation, concurrency: 16 }
          r.status = 'interrupted'
        }),
      ),
      k,
    )
  })

  test('a different profile, --runs, filter, tag, trait or judge model changes the key', () => {
    const k = key(base())
    const changes: Array<[string, (r: Scoped) => void]> = [
      ['profile name', (r) => (r.profile.name = 'full')],
      ['profile defaults', (r) => (r.profile.defaults.runs = 5)],
      ['profile limit', (r) => (r.profile.limit.runs = 1)],
      ['--runs', (r) => (r.invocation.runs = 1)],
      ['filter', (r) => (r.invocation.filters = ['greet'])],
      ['tag', (r) => (r.invocation.tags = ['smoke'])],
      ['trait', (r) => (r.invocation.traits = ['os=linux'])],
      ['judge model', (r) => (r.config.judgeModel = 'other')],
      ['threshold', (r) => (r.config.threshold = 0.5)],
      ['config runs', (r) => (r.config.runs = 3)],
      ['bestOf', (r) => (r.config.bestOf = 3)],
      ['environment', (r) => (r.config.environment = 'skill')],
      ['fingerprint scope', (r) => r.stack.fingerprintScope.pop()],
    ]
    const keys = new Set([k])
    for (const [what, edit] of changes) {
      const changed = key(edited(edit))
      assert.notEqual(changed, k, what)
      keys.add(changed)
    }
    keys.add(key({ ...base(), profile: null }))
    assert.equal(keys.size, changes.length + 2, 'every change, and no profile, gives its own key')
  })

  test("the run's sandboxes, which a retry, a rename or a new eval changes, keep the key", () => {
    const both = edited((r) => (r.config.sandbox = 'fake-a, fake-b'))
    for (const sandbox of ['fake-b', 'fake-b, fake-a', 'fake-b, fake-c, fake-a', 'docker']) {
      assert.equal(key(edited((r) => (r.config.sandbox = sandbox))), key(both), sandbox)
    }
  })

  test('the order of filters, tags, traits and set-like profile lists does not matter', () => {
    const a = edited((r) => {
      r.invocation = {
        ...r.invocation,
        filters: ['a', 'b'],
        tags: ['x', 'y'],
        traits: ['k=1', 'j=2'],
      }
    })
    const b = edited((r) => {
      r.invocation = {
        ...r.invocation,
        filters: ['b', 'a'],
        tags: ['y', 'x'],
        traits: ['j=2', 'k=1'],
      }
      r.profile.defaults.harness = ['b', 'a']
      r.profile.limit = { traits: { os: ['mac', 'linux'] }, harness: ['b', 'a'] }
      r.stack.fingerprintScope.reverse()
    })
    assert.equal(key(a), key(b))
  })

  test('subset: each narrowing argument sets it; none leaves it unset', () => {
    assert.deepEqual(
      { ...runScope(base()), configKey: '' },
      { profile: 'smoke', subset: false, configKey: '' },
    )
    const triggers: Array<[string, (r: Scoped) => void]> = [
      ['filter', (r) => (r.invocation.filters = ['greet'])],
      ['tag', (r) => (r.invocation.tags = ['smoke'])],
      ['trait', (r) => (r.invocation.traits = ['os=linux'])],
      ['--runs', (r) => (r.invocation.runs = 1)],
    ]
    for (const [what, edit] of triggers) assert.equal(runScope(edited(edit)).subset, true, what)
    assert.equal(runScope(edited((r) => (r.invocation.traits = []))).subset, false, 'traits: []')
  })

  test('a skipped or todo eval leaves subset unset: the record has no .only to tell apart', () => {
    const skipped = edited((r) => {
      const [e] = r.evals
      assert.ok(e)
      const t = structuredClone(e)
      e.skip = true
      e.outcome = 'skipped'
      t.todo = true
      t.outcome = 'skipped'
      r.evals.push(t)
    })
    assert.equal(runScope(skipped).subset, false)
    assert.equal(key(skipped), key(base()))
  })

  test('a record without invocation hashes as an empty one and is not a subset', () => {
    const old: RunRecord = base()
    delete old.invocation
    assert.deepEqual(runScope(old), runScope(base()))
    assert.equal(runScope({ ...base(), profile: null }).profile, null)
  })

  test('every corpus record derives a scope', () => {
    const { records } = corpus()
    assert.ok(records.length > 0)
    for (const { file, value } of records) {
      const record = readableRecord(structuredClone(value) as RunRecord)
      const scope = runScope(record)
      assert.match(scope.configKey, /^[0-9a-f]{64}$/, file)
      assert.equal(scope.profile, record.profile?.name ?? null, file)
      assert.equal(typeof scope.subset, 'boolean', file)
    }
  })

  test('the history entry and the report header carry it; the Markdown is unchanged', () => {
    const record = edited((r) => (r.invocation.tags = ['smoke']))
    const scope = runScope(record)
    assert.deepEqual(runHeader(record, true).scope, scope)
    const report = buildRunReport(record, { links: { base: './' } })
    assert.deepEqual(report.header.scope, scope)
    assert.deepEqual(runReportSchema.parse(report).header.scope, scope)
    const without = structuredClone(report)
    delete without.header.scope
    assert.doesNotThrow(() => runReportSchema.parse(without), 'a report without scope still reads')
    assert.equal(runReportMarkdown(report), runReportMarkdown(without))
  })
})
