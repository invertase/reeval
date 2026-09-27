// `pnpm schema:check` (CI) and `pnpm schema:update`: holds every shape ES persists and reads back
// to its committed snapshot in schema/, so a change can't silently stop older files from loading.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIGRATIONS,
  READ_DEFAULTS,
  readableAnalysis,
  readableRecord,
  readableTranscriptLine,
} from '../../src/view/record.ts'
import { type Change, checkDefaults, compare } from './compat.ts'
import { CORPUS_DIR, corpus } from './corpus.ts'
import { generate, type ShapeSchema } from './generate.ts'
import { PACKAGE_DIR, type PersistedShape, SHAPES, SNAPSHOT_DIR } from './shapes.ts'
import { validate } from './validate.ts'

export const snapshotFile = (shape: Pick<PersistedShape, 'name'>, dir = SNAPSHOT_DIR) =>
  join(dir, `${shape.name}.schema.json`)
export const encode = (doc: ShapeSchema) => `${JSON.stringify(doc, null, 2)}\n`

export type ShapeReport = {
  shape: PersistedShape
  changes: Change[]
  breaking: Change[]
  /** The snapshot isn't what the code generates (a compatible change, or a first snapshot). */
  stale: boolean
}

export function checkShape(
  shape: PersistedShape,
  current: ShapeSchema,
  committed: ShapeSchema | null,
  options = {
    defaults: READ_DEFAULTS[shape.name].map((d) => d.path),
    migrations: Object.keys(MIGRATIONS[shape.name] ?? {}).map(Number),
  },
): ShapeReport {
  const changes = [
    ...(committed ? compare(committed, current, options) : []),
    ...checkDefaults(current, options.defaults),
  ]
  return {
    shape,
    changes,
    breaking: changes.filter((c) => c.breaking),
    stale: !committed || encode(committed) !== encode(current),
  }
}

const FIX: Partial<Record<Change['kind'], string>> = {
  'added-required': 'new',
  'made-required': 'new',
  removed: 'removed',
  narrowed: 'narrowed',
}

/** What the author has to do, for each breaking change, in words. */
export function explain(reports: ShapeReport[]): string {
  const lines: string[] = []
  for (const r of reports.filter((x) => x.breaking.length)) {
    const { shape } = r
    lines.push(
      `✗ ${shape.type} (${shape.file}) changed in a way that breaks files ES already wrote.`,
      `  ${shape.where}. Snapshot: ${relative(PACKAGE_DIR, snapshotFile(shape))}`,
      '',
    )
    for (const c of r.breaking) {
      lines.push(`  - ${c.message}`)
      const how = FIX[c.kind]
      const version = shape.versionField
        ? `bump ${shape.type}'s ${shape.versionField} and add a migration from the old version to MIGRATIONS['${shape.name}'] in src/view/record.ts`
        : `bump the run record's schemaVersion with a migration (MIGRATIONS in src/view/record.ts) that rewrites this shape too`
      if (how === 'new') {
        lines.push(
          '    Fix it one of these ways:',
          `    1. Make it optional in the type (\`${c.path.split('.').at(-1)}?: …\`) and handle it missing where it's read.`,
          `    2. Give it a read default: add { path: '${c.path}', empty: () => … } to READ_DEFAULTS['${shape.name}'] in`,
          `       src/view/record.ts. test/schema.test.ts then checks a corpus file in test/fixtures/records/ lacks it,`,
          `       and every reader runs on that file.`,
          `    3. If old files can't mean anything sensible without it, ${version}.`,
        )
      } else if (how === 'removed') {
        lines.push(
          '    An older ES reading a file this version writes would crash without it. Either:',
          '    1. Keep the field in the type (optional, with a /** @deprecated */ note) and keep writing it; or',
          `    2. ${version}, so an older ES refuses the new files with a clear message instead.`,
        )
      } else if (how === 'narrowed') {
        lines.push(
          '    Either:',
          '    1. Keep accepting the old values in the type (widen it back) and handle them where it is read; or',
          `    2. ${version} that maps the old values to new ones.`,
        )
      } else if (c.kind === 'default-unused') {
        lines.push('    (READ_DEFAULTS is in src/view/record.ts.)')
      } else if (c.kind === 'version') {
        lines.push(
          `    Add MIGRATIONS['${shape.name}'][<from>] in src/view/record.ts for each older version.`,
        )
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * Every file in the record corpus, read the way ES reads it, checked against the shapes the code
 * describes now: a missing read default (or one dropped later) shows up here as a missing field.
 */
export function checkCorpus(current: Map<string, ShapeSchema>): string[] {
  const problems: string[] = []
  const missing = new Set<string>()
  const at = (file: string) => relative(PACKAGE_DIR, file)
  const report = (file: string, found: string[]) => {
    for (const p of found) {
      const m = /^(?:line \d+: )?(.+): missing$/.exec(p)
      if (m) missing.add((m[1] as string).replace(/\[\d+\]/g, '[]'))
    }
    if (found.length)
      problems.push(
        `${at(file)}:\n${found
          .slice(0, 8)
          .map((p) => `    ${p}`)
          .join('\n')}`,
      )
  }
  const { records, transcripts, analyses } = corpus()
  const shape = (name: string) => current.get(name) as ShapeSchema
  for (const r of records) {
    report(r.file, validate(shape('run-record'), readableRecord(structuredClone(r.value) as never)))
  }
  for (const file of transcripts) {
    const found = new Set<string>()
    for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue
      const read = readableTranscriptLine(JSON.parse(line))
      for (const p of validate(shape('transcript-line'), read)) found.add(`line ${i + 1}: ${p}`)
    }
    report(file, [...found])
  }
  for (const a of analyses) {
    report(a.file, validate(shape('analysis'), readableAnalysis(structuredClone(a.value) as never)))
  }
  if (!problems.length) return []
  return [
    `✗ Files in ${relative(PACKAGE_DIR, CORPUS_DIR)} don't fit the shapes the code describes, once read:`,
    ...problems.map((p) => `  ${p}`),
    '',
    '  A reader gets exactly this, so it would see undefined (or a value its type rules out) there.',
    '  Give each missing field a read default in READ_DEFAULTS (src/view/record.ts), or make it',
    '  optional in the type and handle it missing where it is read.',
    ...[...missing].map((p) => `    e.g. { path: '${p}', empty: () => … }`),
    '',
  ]
}

function readSnapshot(shape: PersistedShape): ShapeSchema | null {
  const file = snapshotFile(shape)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ShapeSchema) : null
}

function main(argv: string[]): number {
  const update = argv.includes('--update')
  const current = generate()
  const reports = SHAPES.map((s) =>
    checkShape(s, current.get(s.name) as ShapeSchema, readSnapshot(s)),
  )
  const broken = reports.filter((r) => r.breaking.length)
  const misfits = checkCorpus(current)
  if (broken.length || misfits.length) {
    process.stderr.write(`${explain(reports)}${misfits.join('\n')}`)
    process.stderr.write(
      'The snapshots in packages/evalsuite/schema/ record what ES has written. See "Changing what ES persists" in AGENTS.md.\n',
    )
    return 1
  }
  const stale = reports.filter((r) => r.stale)
  for (const r of reports) {
    for (const c of r.changes) process.stdout.write(`  ${r.shape.type}: ${c.message}\n`)
  }
  if (!stale.length) {
    process.stdout.write(
      `✓ ${SHAPES.length} persisted shapes match their snapshots in schema/, and every corpus file reads\n`,
    )
    return 0
  }
  if (!update) {
    process.stderr.write(
      `✗ ${stale.map((r) => r.shape.type).join(', ')} changed compatibly, but schema/ wasn't updated. Run \`pnpm --filter @invertase/foobar schema:update\` and commit schema/.\n`,
    )
    return 1
  }
  mkdirSync(SNAPSHOT_DIR, { recursive: true })
  for (const r of stale) {
    writeFileSync(snapshotFile(r.shape), encode(current.get(r.shape.name) as ShapeSchema))
    process.stdout.write(`updated ${relative(PACKAGE_DIR, snapshotFile(r.shape))}\n`)
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
