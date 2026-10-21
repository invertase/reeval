// The feature × tier matrix: the inventory (test/features/inventory.ts) against what covers each
// feature. Pure, so matrix.test.ts can prove the check fails on a made-up inventory.
import type { EvalOptionSpec } from '../features/eval-options.ts'
import { AREAS, type InventoryFeature } from '../features/inventory.ts'

export const TIERS = ['unit', 'plan', 'fake', 'docker', 'podman', 'real'] as const
export type Tier = (typeof TIERS)[number]
const FIXTURE_TIERS: readonly string[] = ['fake', 'docker', 'podman', 'real']

export type Sources = {
  /** The rows of features.test.ts, and whether each directory has a canary. */
  fixtures: { dir: string; tiers: readonly string[]; canary: boolean }[]
  /** plan.test.ts's cases, as `dir/name`. */
  planCases: string[]
  /** A test file's source, by its path under packages/; null when it doesn't exist. */
  testSource: (path: string) => string | null
  /** contract.test.ts's behaviours, and whether each has a canary. */
  contract: { name: string; canary: boolean }[]
  /** Top-level eval/group keys from src/options.ts EVAL_OPTION_KEYS. */
  evalOptionKeys: readonly string[]
  /** Maps each key to the inventory feature that covers it. */
  evalOptionSpecs: EvalOptionSpec[]
  /** Lowercased refusal case names and golden messages from test/refusals/. */
  refusalText: string
}

/** The real-agent suites besides the contract, by the name an inventory `real` entry uses. */
const REAL_SUITES: Record<string, string> = {
  e2e: 'reeval/test/e2e-real.test.ts',
  questions: 'reeval/test/questions-real.test.ts',
}

type Cell = { count: number; canaries: number }
export type MatrixRow = { feature: InventoryFeature; cells: Record<Tier, Cell> }
export type Matrix = { rows: MatrixRow[]; problems: string[] }

const covered = (row: MatrixRow) => TIERS.some((t) => row.cells[t].count > 0)

/** The literal first argument of every `test(`, `it(`, `describe(` or `suite(` call, `.skip` etc. too. */
const testTitles = (source: string) =>
  [
    ...source.matchAll(
      /\b(?:test|it|describe|suite)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g,
    ),
  ].map((m) => m[2] ?? '')

const refusalMentions = (text: string, key: string) => {
  const lower = text.toLowerCase()
  if (key.includes('.')) return lower.includes(key.toLowerCase())
  return lower.includes(`${key} in `)
}

/** Every EVAL_OPTION_KEYS entry and plan/refusal coverage for cascade options. */
export function checkEvalOptionCoverage(
  inventory: InventoryFeature[],
  sources: Pick<Sources, 'evalOptionKeys' | 'evalOptionSpecs' | 'refusalText'>,
): string[] {
  const problems: string[] = []
  const byId = new Map(inventory.map((f) => [f.id, f]))
  const specKeys = new Set(sources.evalOptionSpecs.map((s) => s.key))
  for (const key of sources.evalOptionKeys) {
    if (!specKeys.has(key)) {
      problems.push(
        `eval option "${key}" has no entry in test/features/eval-options.ts: add one naming its inventory feature; when reeval run --dry-run output changes, set plan: true and add a case under test/plan/`,
      )
    }
  }
  const seen = new Set<string>()
  for (const spec of sources.evalOptionSpecs) {
    if (seen.has(spec.key))
      problems.push(`eval option "${spec.key}" is listed twice in eval-options.ts`)
    seen.add(spec.key)
    if (!spec.key.includes('.') && !sources.evalOptionKeys.includes(spec.key)) {
      problems.push(
        `eval-options.ts lists "${spec.key}", which isn't in src/options.ts EVAL_OPTION_KEYS`,
      )
    }
    const feature = byId.get(spec.featureId)
    const at = `eval option "${spec.key}"`
    if (!feature) {
      problems.push(`${at}: inventory feature ${spec.featureId} doesn't exist`)
      continue
    }
    if (spec.plan && !(feature.plan?.length ?? 0)) {
      problems.push(
        `${at}: changes reeval run --dry-run output, so inventory ${spec.featureId} needs a plan case under test/plan/, not a feature fixture (see test/features/README.md#which-tier)`,
      )
    }
    if (spec.refusals && !refusalMentions(sources.refusalText, spec.key)) {
      problems.push(
        `${at}: add refusal rows in test/refusals/ for inventory ${spec.featureId} (REEVAL_UPDATE_SNAPSHOTS=1 pnpm --filter reeval test test/refusals.test.ts)`,
      )
    }
  }
  return problems
}

export function buildMatrix(inventory: InventoryFeature[], sources: Sources): Matrix {
  const problems: string[] = []
  const fixtures = new Map(sources.fixtures.map((f) => [f.dir, f]))
  const planCases = new Set(sources.planCases)
  const ids = new Set<string>()
  const rows = inventory.map((feature): MatrixRow => {
    const at = `inventory ${feature.id}`
    if (ids.has(feature.id)) problems.push(`${at}: the id is used twice`)
    ids.add(feature.id)
    const cells = Object.fromEntries(TIERS.map((t) => [t, { count: 0, canaries: 0 }])) as Record<
      Tier,
      Cell
    >
    for (const dir of feature.fixtures ?? []) {
      const f = fixtures.get(dir)
      if (!f) {
        problems.push(`${at}: fixture ${dir} isn't in features.test.ts`)
        continue
      }
      for (const tier of f.tiers) {
        if (!FIXTURE_TIERS.includes(tier)) {
          problems.push(`${at}: fixture ${dir} lists tier ${tier}, which the matrix doesn't know`)
          continue
        }
        cells[tier as Tier].count++
        if (f.canary) cells[tier as Tier].canaries++
      }
    }
    for (const c of feature.plan ?? []) {
      if (planCases.has(c)) cells.plan.count++
      else problems.push(`${at}: plan case ${c} isn't in plan.test.ts`)
    }
    for (const ref of feature.tests ?? []) {
      const [file, title, ...rest] = ref.split(' › ')
      const source = file ? sources.testSource(file) : null
      if (!file || !title || rest.length) problems.push(`${at}: "${ref}" isn't "<file> › <title>"`)
      else if (source === null) problems.push(`${at}: ${file} doesn't exist`)
      else if (!testTitles(source).some((t) => t.includes(title)))
        problems.push(`${at}: ${file} has no test "${title}"`)
      else cells.unit.count++
    }
    for (const ref of feature.real ?? []) {
      const [suite, title, ...rest] = ref.split(' › ')
      const behaviour = sources.contract.find((b) => b.name === title)
      const file = suite ? REAL_SUITES[suite] : undefined
      if (rest.length || !title || (suite !== 'contract' && !file))
        problems.push(
          `${at}: "${ref}" isn't "contract › <behaviour>", "e2e › <title>" or "questions › <title>"`,
        )
      else if (suite === 'contract' && !behaviour)
        problems.push(`${at}: contract.test.ts has no behaviour "${title}"`)
      else if (file && !testTitles(sources.testSource(file) ?? '').some((t) => t.includes(title)))
        problems.push(`${at}: ${file.split('/').at(-1)} has no test "${title}"`)
      else {
        cells.real.count++
        if (behaviour?.canary) cells.real.canaries++
      }
    }
    const row = { feature, cells }
    if (feature.gap !== undefined && !feature.gap.trim())
      problems.push(`${at}: a known gap needs its reason`)
    if (covered(row) && feature.gap)
      problems.push(`${at}: it's covered now, so it's no longer a gap: remove its gap`)
    if (!covered(row) && !feature.gap)
      problems.push(
        `${at}: nothing covers it on any tier. Add a fixture, plan case or test, or mark it a known gap with the reason`,
      )
    return row
  })
  const claimed = (key: 'fixtures' | 'plan', name: string) =>
    inventory.some((f) => f[key]?.includes(name))
  for (const f of sources.fixtures)
    if (!claimed('fixtures', f.dir))
      problems.push(`fixture ${f.dir} covers no feature: add it to an entry in inventory.ts`)
  for (const b of sources.contract)
    if (!inventory.some((f) => f.real?.includes(`contract › ${b.name}`)))
      problems.push(
        `contract behaviour "${b.name}" covers no feature: add it to an entry in inventory.ts`,
      )
  for (const c of sources.planCases)
    if (!claimed('plan', c))
      problems.push(`plan case ${c} covers no feature: add it to an entry in inventory.ts`)
  problems.push(...checkEvalOptionCoverage(inventory, sources))
  return { rows, problems }
}

function cell(tier: Tier, { count, canaries }: Cell): string {
  if (count === 0) return '—'
  if (tier === 'unit' || tier === 'plan') return `✓ ${count}`
  return canaries === count ? `● ${count}` : `◐ ${count} (${count - canaries} without a canary)`
}

export function renderMarkdown({ rows }: Matrix): string {
  const gaps = rows.filter((r) => r.feature.gap)
  const perTier = TIERS.map((t) => `${t} ${rows.filter((r) => r.cells[t].count > 0).length}`)
  const lines = [
    '# Feature coverage',
    '',
    '<!-- Generated by `pnpm features:matrix --write` from test/features/inventory.ts, the fixture',
    '     table in features.test.ts and the cases in plan.test.ts. Edit those, not this file. -->',
    '',
    `${rows.length} features: ${rows.length - gaps.length} covered on at least one tier, ${gaps.length} known gaps. Features per tier: ${perTier.join(', ')}.`,
    '',
    '- **unit**: plain `node:test` cases, including runner-level tests through the CLI',
    '- **plan**: `reeval run --dry-run --json` snapshots in `plan.test.ts`',
    '- **fake**, **docker**, **podman**: feature fixtures in `features.test.ts` on the fake sandbox, in Docker and in rootless Podman',
    '- **real**: real-tier fixtures in `features.test.ts` (real Cursor), and the harness contract (`contract.test.ts`) and CLI end to end (`e2e-real.test.ts`) on every real harness',
    '- `● n`: n fixtures or contract behaviours, each with a canary that must fail · `◐ n`: some without one · `✓ n`: n cases or tests · `—`: nothing',
    '',
  ]
  for (const area of AREAS) {
    const inArea = rows.filter((r) => r.feature.area === area)
    if (inArea.length === 0) continue
    lines.push(
      `## ${area}`,
      '',
      `| Feature | ${TIERS.join(' | ')} |`,
      `|---|${TIERS.map(() => ':-:|').join('')}`,
    )
    for (const r of inArea) {
      const name = r.feature.gap ? `${r.feature.name} **(gap)**` : r.feature.name
      lines.push(`| ${name} | ${TIERS.map((t) => cell(t, r.cells[t])).join(' | ')} |`)
    }
    lines.push('')
  }
  lines.push('## Known gaps', '')
  if (gaps.length === 0) lines.push('None.')
  for (const r of gaps)
    lines.push(`- **${r.feature.name}** (\`${r.feature.id}\`): ${r.feature.gap}`)
  lines.push('')
  return lines.join('\n')
}
