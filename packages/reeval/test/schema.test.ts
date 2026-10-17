// The persisted-shape guard: schema/ snapshots every shape reeval writes and reads back, and a change
// that would stop older files from loading fails here and in CI's `pnpm schema:check`.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  biome,
  checkCorpus,
  checkShape,
  encode,
  explain,
  snapshotFile,
  writeSnapshots,
} from '../scripts/schema/check.ts'
import { compare } from '../scripts/schema/compat.ts'
import { generate, type Schema, type ShapeSchema } from '../scripts/schema/generate.ts'
import { SHAPES } from '../scripts/schema/shapes.ts'
import {
  fillDefaults,
  NewerSchemaError,
  READ_DEFAULTS,
  readableAnalysis,
  readableRecord,
} from '../src/view/record.ts'
import { corpus } from './support/corpus.ts'
import { testDir } from './support/fixture.ts'

const shape = (name: string) => SHAPES.find((s) => s.name === name) as (typeof SHAPES)[number]
const snapshot = (name: string): ShapeSchema =>
  JSON.parse(readFileSync(snapshotFile(shape(name)), 'utf8'))
const copy = <T>(v: T): T => structuredClone(v)
const def = (doc: ShapeSchema, name: string) => doc.$defs[name] as Schema
const none = { defaults: [], migrations: [] }

/** The committed run-record snapshot with one field taken out of a `$defs` object. */
function without(name: string, field: string): ShapeSchema {
  const doc = copy(snapshot('run-record'))
  const d = def(doc, name)
  delete d.properties?.[field]
  d.required = d.required?.filter((r) => r !== field)
  return doc
}

describe('persisted shapes', () => {
  test('each snapshot in schema/ is what the code generates, and nothing breaks older files', () => {
    const current = generate()
    const reports = SHAPES.map((s) => {
      const doc = current.get(s.name) as ShapeSchema
      return checkShape(s, doc, JSON.parse(readFileSync(snapshotFile(s), 'utf8')))
    })
    assert.equal(explain(reports), '')
    const stale = reports.filter((r) => r.stale).map((r) => r.shape.type)
    assert.deepEqual(stale, [], 'run `pnpm --filter reeval schema:update`')
  })

  test('a required field added without a read default fails, and the message says the three fixes', () => {
    const report = checkShape(
      shape('run-record'),
      snapshot('run-record'),
      without('EvalEntry', 'todo'),
      none,
    )
    assert.deepEqual(
      report.breaking.map((c) => [c.kind, c.path]),
      [['added-required', 'evals[].todo']],
    )
    const text = explain([report])
    assert.match(text, /`evals\[\]\.todo` was added as a required field/)
    assert.match(text, /Make it optional in the type \(`todo\?: …`\)/)
    assert.match(
      text,
      /add \{ path: 'evals\[\]\.todo', empty: \(\) => … \} to READ_DEFAULTS\['run-record'\]/,
    )
    assert.match(text, /bump RunRecord's schemaVersion and add a migration/)
  })

  test('with a read default, or optional, the same field passes', () => {
    const old = without('EvalEntry', 'todo')
    const defaulted = compare(old, snapshot('run-record'), {
      defaults: ['evals[].todo'],
      migrations: [],
    })
    assert.deepEqual(
      defaulted.map((c) => [c.kind, c.breaking]),
      [['added-defaulted', false]],
    )
    const optional = copy(snapshot('run-record'))
    def(optional, 'EvalEntry').required = def(optional, 'EvalEntry').required?.filter(
      (r) => r !== 'todo',
    )
    assert.deepEqual(
      compare(old, optional, none).map((c) => c.kind),
      ['added-optional'],
    )
  })

  test('the guard names the fields the before-80 snapshot lacks', () => {
    const before80: ShapeSchema = JSON.parse(
      readFileSync(join(testDir, 'fixtures/schema/before-80/run-record.schema.json'), 'utf8'),
    )
    const bare = compare(before80, snapshot('run-record'), none).filter((c) => c.breaking)
    assert.deepEqual(bare.map((c) => c.path).sort(), [
      'evals[].attempts[].effort',
      'evals[].attempts[].servedEffort',
      'evals[].cells[].effort',
      'evals[].todo',
      'plan.sandboxWarnings',
      'stack.harnesses[].effort',
      'stack.harnesses[].resolvedEffort',
      'stack.harnesses[].resolvedModels',
    ])
    const report = checkShape(shape('run-record'), snapshot('run-record'), before80)
    assert.equal(explain([report]), '', 'READ_DEFAULTS covers every added required field')
  })

  test('a removed or renamed field fails', () => {
    const old = copy(snapshot('run-record'))
    def(old, 'Cost').properties = { ...def(old, 'Cost').properties, usd: { type: 'number' } }
    def(old, 'Cost').required?.push('usd')
    const [c] = compare(old, snapshot('run-record'), none)
    assert.deepEqual([c?.kind, c?.path, c?.breaking], ['removed', 'cost.usd', true])
    assert.match(
      explain([checkShape(shape('run-record'), snapshot('run-record'), old, none)]),
      /Keep the field in the type/,
    )
  })

  test('narrowing fails: a lost enum value, a lost null, an optional field made required', () => {
    const now = snapshot('run-record')
    const wider = copy(now)
    const status = def(wider, 'RunRecord').properties?.status as Schema
    status.enum = [...(status.enum ?? []), 'cancelled']
    const author = def(wider, 'RunRecord').properties as Record<string, Schema>
    author.author = { anyOf: [{ type: 'null' }, { type: 'string' }] }
    def(wider, 'RunRecord').required = def(wider, 'RunRecord').required?.filter(
      (r) => r !== 'budget',
    )
    assert.deepEqual(
      compare(wider, now, none)
        .map((c) => [c.kind, c.path])
        .sort(),
      [
        ['made-required', 'budget'],
        ['narrowed', 'author'],
        ['narrowed', 'status'],
      ],
    )
  })

  test('widening passes: an older reeval reading the new file is the forward-direction test', () => {
    const now = snapshot('run-record')
    const wider = copy(now)
    const status = def(wider, 'RunRecord').properties?.status as Schema
    status.enum = [...(status.enum ?? []), 'cancelled']
    assert.deepEqual(
      compare(now, wider, none).map((c) => [c.kind, c.path, c.breaking]),
      [['widened', 'status', false]],
    )
  })

  test('a transcript event type that disappears fails, by its variant', () => {
    const now = snapshot('transcript-line')
    const fewer = copy(now)
    const line = def(fewer, 'TranscriptLine')
    line.anyOf = line.anyOf?.filter((s) => (s.properties?.type as Schema)?.const !== 'tool')
    const changes = compare(now, fewer, none)
    assert.deepEqual(
      changes.map((c) => [c.kind, c.path]),
      [['removed', '<type=tool>']],
    )
  })

  test('a schemaVersion bump makes breaking changes pass only with a migration from the old version', () => {
    const old = without('EvalEntry', 'todo')
    const bumped = copy(snapshot('run-record'))
    bumped['x-schemaVersion'] = 2
    const unmigrated = compare(old, bumped, none)
    assert.deepEqual(
      unmigrated.filter((c) => c.breaking).map((c) => c.kind),
      ['added-required', 'version'],
    )
    const migrated = compare(old, bumped, { defaults: [], migrations: [1] })
    assert.deepEqual(
      migrated.filter((c) => c.breaking),
      [],
    )
  })

  test('a read default must name a required field of its shape', () => {
    const report = checkShape(shape('run-record'), snapshot('run-record'), snapshot('run-record'), {
      defaults: ['evals[].todoo', 'evals[].cells[].lift', 'evals[].todo'],
      migrations: [],
    })
    assert.deepEqual(
      report.breaking.map((c) => c.path),
      ['evals[].todoo', 'evals[].cells[].lift'],
    )
    assert.match(explain([report]), /the field is optional, so readers already handle it missing/)
  })

  test('descriptions come from TSDoc, and changing them is documentation only', () => {
    const now = snapshot('run-record')
    assert.match(def(now, 'Cost').description ?? '', /\w/)
    assert.match(def(now, 'RunRecord').properties?.status?.description ?? '', /\w/)
    const bare = JSON.parse(JSON.stringify(now), (k, v) => (k === 'description' ? undefined : v))
    const reworded = copy(now)
    def(reworded, 'Cost').description = 'Reworded.'
    for (const [before, after] of [
      [bare, now],
      [now, bare],
      [now, reworded],
    ]) {
      const report = checkShape(shape('run-record'), after as ShapeSchema, before as ShapeSchema)
      assert.deepEqual(report.changes, [])
      assert.equal(report.stale, true, 'schema:update still rewrites the snapshot')
    }
  })
})

const has = (value: unknown, segments: string[]): boolean => {
  if (!value || typeof value !== 'object') return false
  const [head = '', ...rest] = segments
  const branch = /^<(\w+)=(.+)>$/.exec(head)
  const obj = value as Record<string, unknown>
  if (branch) return String(obj[branch[1] as string]) === branch[2] ? has(value, rest) : true
  const [, key = head, walk] = /^(.+?)(\[\]|\{\})?$/.exec(head) ?? []
  if (!rest.length && !walk) return key in obj
  const child = obj[key]
  const children =
    walk === '[]'
      ? ((child as unknown[]) ?? [])
      : walk === '{}'
        ? Object.values(child ?? {})
        : [child]
  return children.every((c) => has(c, rest))
}

describe('read defaults', () => {
  const { records, transcripts, analyses } = corpus()
  const lines = transcripts.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l)),
  )

  test('each read default runs on a corpus file written before its field existed', () => {
    const files = {
      'run-record': records.map((r) => r.value),
      'transcript-line': lines,
      analysis: analyses.map((a) => a.value),
      'debug-request': [],
      'cli-invocation': [],
    }
    for (const [name, defaults] of Object.entries(READ_DEFAULTS)) {
      for (const d of defaults) {
        const lacking = files[name as keyof typeof files].some((v) => !has(v, d.path.split('.')))
        assert.ok(
          lacking,
          `READ_DEFAULTS['${name}'] has ${d.path}, but no file in test/fixtures/records/ lacks it, so nothing tests the default. Add a corpus entry recorded before the field existed (see AGENTS.md).`,
        )
      }
    }
  })

  test('every corpus record, transcript line and saved analysis, read, fits the current schema', () => {
    assert.ok(records.length > 0 && lines.length > 0 && analyses.length > 0)
    const current = new Map(SHAPES.map((s) => [s.name, snapshot(s.name)]))
    assert.equal(checkCorpus(current).join('\n'), '')
  })

  test('a default fills in only what is missing, through arrays and union variants', () => {
    const record = {
      schemaVersion: 1,
      plan: {},
      stack: { harnesses: [{}, { resolvedModels: ['m'] }] },
      evals: [{ todo: true }, {}],
    }
    fillDefaults('run-record', record)
    assert.deepEqual(record.plan, { sandboxWarnings: [] })
    assert.deepEqual(record.stack.harnesses, [
      { resolvedModels: [], effort: null, resolvedEffort: [] },
      { resolvedModels: ['m'], effort: null, resolvedEffort: [] },
    ])
    assert.deepEqual(record.evals, [{ todo: true }, { todo: false }])
  })

  test('a file from a newer reeval throws NewerSchemaError naming both versions', () => {
    const record = copy(records[0]?.value) as Record<string, unknown>
    record.schemaVersion = 2
    assert.throws(
      () => readableRecord(record as never),
      (e: Error) =>
        e instanceof NewerSchemaError &&
        /written by a newer reeval \(schemaVersion 2; this reeval reads up to 1\)\. Upgrade reeval to read it\./.test(
          e.message,
        ),
    )
    assert.throws(
      () => readableAnalysis({ kind: 'es-analysis', schemaVersion: 3 } as never),
      NewerSchemaError,
    )
  })
})

describe('schema:update', () => {
  test('writes snapshots that pass biome ci; canary: the unformatted JSON does not', () => {
    // Inside the package and not gitignored, so Biome checks it with the repo's config.
    const dir = join(import.meta.dirname, '..', `schema-update-check-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    try {
      const current = generate()
      writeSnapshots(
        SHAPES.map((s) => ({
          file: snapshotFile(s, dir),
          doc: current.get(s.name) as ShapeSchema,
        })),
      )
      const written = biome(['ci', dir])
      assert.equal(written.status, 0, written.stdout + written.stderr)
      for (const s of SHAPES) {
        const doc = JSON.parse(readFileSync(snapshotFile(s, dir), 'utf8'))
        assert.deepEqual(doc, current.get(s.name), 'formatting keeps the content')
      }

      const raw = join(dir, 'raw.schema.json')
      writeFileSync(raw, encode(current.get('run-record') as ShapeSchema))
      assert.notEqual(biome(['ci', raw]).status, 0, 'JSON.stringify output fails biome ci')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
