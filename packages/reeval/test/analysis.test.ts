// The analysis pipeline: the facts views in `reeval query`, effort next to
// lift, and `reeval analyze`. The facts come out exactly on two real dogfood histories (trimmed by
// fixtures/analysis/trim.mjs), each verdict rule has a canary where the opposite data must flip it,
// and the model step runs on a fake model that returns canned (and deliberately wrong) answers.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, test } from 'node:test'
import { type Digest as AnalysisDigest, RULES } from '../src/analysis/digest.ts'
import { analysisSchema, SYSTEM_PROMPT } from '../src/analysis/schema.ts'
import { capConfidence, validateAnalysis } from '../src/analysis/validate.ts'
import { COMMANDS, checkCommand, FLAGS } from '../src/cli-spec.ts'
import { fingerprintOf } from '../src/history/assemble.ts'
import type { FingerprintParts } from '../src/history/types.ts'
import { EFFECT_MIN_COUNTED, mannWhitney, minimumP } from '../src/stats.ts'
import { createStudioApp } from '../src/studio/server.ts'
import { formatTokens } from '../src/usage.ts'
import { analysisDataPath, pinnedAnalysis } from '../src/view/analysis.ts'
import {
  contrastEffort,
  directional,
  EFFORT_MIN_RUNS,
  effortChangeLabel,
  effortLabel,
} from '../src/view/effort.ts'
import { formatUsage } from '../src/view/model.ts'
import { fakeConfig, pkgRoot, project, readRun, runCli } from './helpers.ts'
import { type StudyOptions, studyFiles } from './support/study.ts'

type Row = Record<string, unknown>
const FIXTURES = join(pkgRoot, 'test/fixtures/analysis')
const UPDATE = !!process.env.REEVAL_UPDATE_SNAPSHOTS

const CONFIG = `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harnesses: fakeHarness({}),
  environments: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
  ANALYSIS
})
`

/** A compare eval whose variant writes a file the control never does. */
async function compareProject(name: string, runs: number) {
  return project(name, {
    'reeval.config.ts': fakeConfig({ harness: "{ withSkill: { files: { 'ok.txt': 'y' } } }" }),
    'skills/s/SKILL.md': '---\nname: s\ndescription: A skill. Use when testing.\n---\nBody.\n',
    'evals/c.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const plain = defineEnvironment('plain', { sandbox })
const skilled = defineEnvironment('skilled', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/s')],
}))
evaluate('greets', { compare: { baseline: plain, variants: [skilled] }, runs: ${runs} }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
  })
}

/** A project whose history is a copy of a fixture history, with an optional `analysis` config. */
async function historyProject(name: string, fixture: string, analysis = '') {
  const p = await project(name, { 'reeval.config.ts': CONFIG.replace('ANALYSIS', analysis) })
  cpSync(join(FIXTURES, fixture), join(p.dir, 'evals/.history'), { recursive: true })
  return p
}

async function query(dir: string, sql: string): Promise<Row[]> {
  const r = await runCli(dir, ['query', sql, '--json'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  return JSON.parse(r.stdout) as Row[]
}

/** The digest `reeval analyze --context` hands over, parsed back out of its Markdown. */
async function digestOf(dir: string, args: string[] = []) {
  const r = await runCli(dir, ['analyze', '--context', ...args])
  assert.equal(r.code, 0, r.stderr)
  const json = /```json\n([\s\S]*?)\n```/.exec(r.stdout)?.[1]
  assert.ok(json, 'the context holds the digest')
  return { text: r.stdout, digest: JSON.parse(json) as Digest }
}

type Digest = {
  scope: { base: string | null }
  facts: Array<Row & { id: string; kind: string; tier?: string }>
  evidence: Array<{ id: string; ref: string; lines: string[] }>
  attempts: Record<string, Row>
  rules: string[]
  setup?: { evals: Array<{ tag: string; id: string; task: string; tags: string[] }> }
}

/** Compares `value` with a golden file; REEVAL_UPDATE_SNAPSHOTS=1 rewrites it. */
function golden(name: string, value: unknown) {
  const path = join(FIXTURES, `${name}.golden.json`)
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (UPDATE || !existsSync(path)) writeFileSync(path, text)
  assert.equal(text, readFileSync(path, 'utf8'), `${name} differs from ${relative(pkgRoot, path)}`)
}

const FACT_QUERIES = {
  effort:
    'SELECT run_id, eval_key, cell_key, n, tools_median, agent_s_median, tools_ratio, tools_p, separated, verdict, time_verdict, tokens_median, tokens_verdict, tokens_note FROM effort ORDER BY run_id, eval_key, cell_key',
  factor_effects:
    'SELECT factor, level, baseline, context, tier, run_id, eval_key, strata, runs, variant_pass, variant_counted, control_pass, control_counted, points, lo, hi, pass_verdict, tools_ratios, tools_p, consistent, separated, effort_verdict FROM factor_effects ORDER BY tier, factor, level, context, eval_key, run_id',
  flaky_cells:
    'SELECT eval_key, cell_key, runs, pass, counted, lo, hi, verdict, cause FROM flaky_cells',
  drift:
    'SELECT run_id, eval_key, cell_key, changed, changed_paths, noise, real_changed FROM drift ORDER BY run_id, eval_key, cell_key',
  skill_reads:
    'SELECT run_id, cell_key, skill, COUNT(*) AS attempts, SUM(read_line IS NOT NULL) AS read, MIN(read_line) AS first FROM skill_reads GROUP BY run_id, cell_key, skill ORDER BY run_id, cell_key',
}

async function facts(dir: string) {
  const out: Record<string, Row[]> = {}
  for (const [name, sql] of Object.entries(FACT_QUERIES)) out[name] = await query(dir, sql)
  return out
}

const pooledAcrossEvals = (rows: Row[], level: string) =>
  rows.find((r) => r.tier === 'pooled' && r.eval_key === null && r.level === level)

describe('facts on the dogfood history (2 runs, 36 real Cursor attempts)', () => {
  test('es-good cuts tool calls 3/3 evals at p = 0.029; lift is within noise; es-weak does nothing', async () => {
    const p = await historyProject('facts-dogfood', 'dogfood')
    const all = await facts(p.dir)
    golden('dogfood-facts', all)

    const good = pooledAcrossEvals(all.factor_effects as Row[], 'es-good')
    assert.deepEqual(
      [good?.tools_ratios, good?.tools_p, good?.consistent, good?.separated, good?.effort_verdict],
      ['×0.20 / ×0.51 / ×0.11', 0.0286, 3, 3, 'fewer'],
    )
    assert.deepEqual(
      [good?.variant_pass, good?.variant_counted, good?.control_pass, good?.control_counted],
      [12, 12, 11, 12],
    )
    assert.deepEqual(
      [good?.points, good?.lo, good?.hi, good?.pass_verdict],
      [0.083, -0.169, 0.354, 'noise'],
    )
    const weak = pooledAcrossEvals(all.factor_effects as Row[], 'es-weak')
    assert.deepEqual([weak?.effort_verdict, weak?.pass_verdict], ['noise', 'noise'])

    const perEval = (all.factor_effects as Row[]).filter(
      (r) => r.tier === 'pooled' && r.level === 'es-good' && r.eval_key !== null,
    )
    assert.deepEqual(
      perEval.map((r) => [r.runs, r.tools_p, r.effort_verdict]),
      [
        [2, 0.0286, 'fewer'],
        [2, 0.0286, 'fewer'],
        [2, 0.0286, 'fewer'],
      ],
      'each eval, pooled over both runs: 4 against 4, fully separated',
    )
    const oneRun = (all.effort as Row[]).filter(
      (r) => r.cell_key === 'cursor:composer-2.5/es-good/es-tarball',
    )
    assert.ok(
      oneRun.every((r) => r.verdict === 'insufficient'),
      'within one run it is 2 against 2, which no rank test can call',
    )
    assert.deepEqual(
      (all.factor_effects as Row[])
        .filter((r) => r.tier === 'not_measured')
        .map((r) => [r.factor, r.level]),
      [
        ['harness', 'cursor'],
        ['model', 'cursor:composer-2.5'],
        ['sandbox', 'es-tarball'],
      ],
    )
    assert.deepEqual(
      (all.skill_reads as Row[]).map((r) => [r.skill, r.read, r.attempts, r.first]),
      [
        ['es-good', 6, 6, 4],
        ['es-weak', 6, 6, 4],
        ['es-good', 6, 6, 4],
        ['es-weak', 6, 6, 4],
      ],
      'every skill attempt read its SKILL.md, at transcript line 4',
    )
  })

  test('flaky: one failure in 4 comparable attempts is mixed, not flaky', async () => {
    const p = await historyProject('facts-flaky', 'dogfood')
    const old = await query(p.dir, 'SELECT eval_key, key FROM cells WHERE pass > 0 AND fail > 0')
    assert.equal(old.length, 1, 'one mixed cell is in cells')
    const flaky = await query(p.dir, 'SELECT * FROM flaky_cells')
    assert.deepEqual(
      flaky.map((f) => [f.cell_key, f.runs, f.pass, f.counted, f.verdict, f.cause]),
      [['cursor:composer-2.5/broken-project/es-tarball', 2, 3, 4, 'mixed', 'agent']],
      'pooled over both runs, which are comparable once runtime state is left out; a 0.10 verdict is the agent, not the judge',
    )
    assert.deepEqual([flaky[0]?.lo, flaky[0]?.hi], [0.301, 0.954])
  })

  test('drift: only Cursor runtime state changed, so it is noise', async () => {
    const p = await historyProject('facts-drift', 'dogfood')
    const drift = await query(p.dir, 'SELECT * FROM drift')
    assert.equal(drift.length, 9, 'every cell drifted')
    assert.ok(
      drift.every((d) => d.changed === 'context' && d.noise === 1 && d.real_changed === null),
    )
    assert.deepEqual(
      [...new Set(drift.flatMap((d) => String(d.changed_paths).split(', ')))].map((path) =>
        path.split('/').slice(-2).join('/'),
      ),
      ['.cursor/cli-config.json', 'skills-cursor/.sync-manifest.json'],
    )
  })
})

describe('facts on the harness-compare history (Cursor and Antigravity, 3 runs)', () => {
  test('harness contrasts are controlled within a run; a clean sweep of 2 a side is too few to call', async () => {
    const p = await historyProject('facts-harness', 'harness-compare')
    const all = await facts(p.dir)
    golden('harness-compare-facts', all)
    const rows = all.factor_effects as Row[]
    const compareControl = rows.find(
      (r) =>
        r.tier === 'controlled' &&
        r.factor === 'harness' &&
        r.context === 'control' &&
        String(r.eval_key).startsWith('evals/compare.es.ts'),
    )
    assert.deepEqual(
      [
        compareControl?.level,
        compareControl?.baseline,
        compareControl?.variant_pass,
        compareControl?.control_pass,
        compareControl?.pass_verdict,
      ],
      ['antigravity:gemini-3.8-flash-low', 'cursor:composer-2.5', 0, 2, 'insufficient'],
      'antigravity failed both control attempts that cursor passed: 2 a side is below the minimum',
    )
    assert.deepEqual(
      rows.filter((r) => r.tier === 'not_measured').map((r) => r.factor),
      ['sandbox'],
      'two harnesses and two models were measured',
    )
    assert.deepEqual(all.flaky_cells, [])
  })
})

describe('canaries: the verdicts flip when the data does', () => {
  const edit = (dir: string, change: (record: Row & { evals: Row[] }) => void) => {
    const history = join(dir, 'evals/.history')
    for (const name of readdirSync(history).filter((n) => n.endsWith('.json'))) {
      const path = join(history, name)
      const record = JSON.parse(readFileSync(path, 'utf8'))
      change(record)
      writeFileSync(path, JSON.stringify(record))
    }
  }
  type A = {
    cell: string
    activity: { tools: number }
    context: Array<{ path: string; sha256: string }>
  }

  test('a variant that makes the agent work harder is "more" tool calls', async () => {
    const p = await historyProject('canary-effort', 'dogfood')
    edit(p.dir, (record) => {
      for (const e of record.evals as Array<{ attempts: A[] }>) {
        for (const a of e.attempts)
          if (a.cell.includes('/es-good/')) a.activity.tools = 200 + a.activity.tools
      }
    })
    const good = pooledAcrossEvals(await query(p.dir, 'factor_effects'), 'es-good')
    assert.equal(good?.effort_verdict, 'more')
  })

  test('a real context file (a skill) that changed is drift, not noise', async () => {
    const p = await historyProject('canary-drift', 'dogfood')
    edit(p.dir, (record) => {
      if (!String(record.runId).includes('041aef3')) return
      for (const e of record.evals as Array<{ attempts: A[] }>) {
        for (const a of e.attempts) {
          for (const c of a.context)
            if (c.path.endsWith('.ai-sdk-harness-skills.json')) c.sha256 = 'f'.repeat(64)
        }
      }
    })
    const drift = await query(p.dir, 'SELECT noise, real_changed FROM drift')
    assert.ok(drift.length > 0 && drift.every((d) => d.noise === 0 && d.real_changed === 'context'))
  })

  test('a gateway-only change is drift with an observed fact, as compare names it', async () => {
    type C = { key: string; fingerprint: string; fingerprintParts: FingerprintParts }
    const gatewayProject = async (name: string, gateways: Record<string, string>) => {
      const p = await historyProject(name, 'dogfood')
      const context = new Map<string, string>()
      edit(p.dir, (record) => {
        const run = String(record.runId).includes('041aef3') ? 'head' : 'base'
        for (const e of record.evals as Array<{ key: string; cells: C[] }>) {
          for (const c of e.cells) {
            const id = `${e.key}\0${c.key}`
            if (run === 'base') context.set(id, c.fingerprintParts.context)
            else c.fingerprintParts.context = context.get(id) as string
            c.fingerprintParts.gateway = gateways[run]
            c.fingerprint = fingerprintOf(c.fingerprintParts)
          }
        }
      })
      return p
    }
    const observed = (rows: Row[]) =>
      rows.filter((r) => r.tier === 'observed').map((r) => [r.factor, r.note])

    const p = await gatewayProject('canary-gateway', { head: 'vercel' })
    const drift = await query(
      p.dir,
      'SELECT changed, changed_paths, noise, real_changed FROM drift',
    )
    assert.equal(drift.length, 9, 'every cell drifted')
    for (const d of drift) {
      assert.deepEqual(d, {
        changed: 'gateway',
        changed_paths: null,
        noise: 0,
        real_changed: 'gateway',
      })
    }
    assert.deepEqual(
      observed(await query(p.dir, 'factor_effects')),
      Array(9).fill(['gateway', null]),
      'one observed gateway fact per cell',
    )
    const cells = await query(p.dir, 'SELECT DISTINCT fp_gateway FROM cells ORDER BY fp_gateway')
    assert.deepEqual(
      cells.map((c) => c.fp_gateway),
      [null, 'vercel'],
    )
    const runs = (await query(p.dir, 'SELECT run_id FROM runs ORDER BY run_id')).map((r) =>
      String(r.run_id),
    )
    const compared = await runCli(p.dir, ['compare', ...runs, '--json'])
    assert.equal(compared.code, 0, compared.stderr)
    const rows = JSON.parse(compared.stdout).rows as Array<{ status: string; changes?: string[] }>
    assert.ok(
      rows.length > 0 &&
        rows.every((r) => r.status === 'drift' && r.changes?.join() === 'gateway changed'),
      'compare names the same part',
    )

    const removed = await gatewayProject('canary-gateway-removed', { base: 'vercel' })
    assert.deepEqual(
      [...new Set((await query(removed.dir, 'drift')).map((d) => d.real_changed))],
      ['gateway'],
      'a gateway dropped back to direct is drift too',
    )

    const same = await gatewayProject('canary-gateway-same', { base: 'vercel', head: 'vercel' })
    assert.deepEqual(await query(same.dir, 'drift'), [], 'twin: the same gateway is no drift')
    assert.deepEqual(observed(await query(same.dir, 'factor_effects')), [])
  })

  test('a config gate change is drift on the gate: a policy change, not noise or an effect', async () => {
    type C = { fingerprint: string; fingerprintParts: FingerprintParts }
    const config = (gate: string) => fakeConfig({ extra: `runs: 2, gate: ${gate},` })
    const p = await project('canary-gate', {
      'reeval.config.ts': config('{ passRate: 0.5 }'),
      'evals/g.eval.ts': `import { evaluate } from 'reeval'
evaluate('half', async (c) => {
  await c.send('go')
  if (c.attempt.n === 2) throw new Error('the second attempt fails')
})
`,
    })
    assert.equal((await runCli(p.dir, ['run', '--record'])).code, 0)
    assert.equal((await runCli(p.dir)).code, 0)
    assert.deepEqual(await query(p.dir, 'drift'), [], 'twin: the same gate is no drift')
    edit(p.dir, (record) => {
      for (const c of record.evals.flatMap((e) => e.cells as C[])) {
        delete c.fingerprintParts.gate
        c.fingerprint = fingerprintOf(c.fingerprintParts)
      }
    })
    assert.deepEqual(
      await query(p.dir, 'drift'),
      [],
      'a record from before the gate was a part, with the same gate, is no drift either',
    )

    writeFileSync(join(p.dir, 'reeval.config.ts'), config("'all'"))
    assert.equal((await runCli(p.dir)).code, 1)
    const drift = await query(p.dir, 'SELECT changed, noise, real_changed FROM drift')
    assert.deepEqual(drift, [{ changed: 'gate', noise: 0, real_changed: 'gate' }])
    assert.deepEqual(
      (await query(p.dir, 'SELECT fp_gate FROM cells ORDER BY run_id')).map((c) => c.fp_gate),
      [null, 'passRate 0.5', null],
    )
    assert.deepEqual(
      await query(p.dir, "SELECT factor FROM factor_effects WHERE tier = 'observed'"),
      [],
      'the gate scores the same attempts, so it has no effect to observe',
    )
    const flaky = await query(p.dir, 'SELECT counted FROM flaky_cells')
    assert.deepEqual(flaky, [{ counted: 6 }], 'attempts pool across the gate change')
    const { text } = await digestOf(p.dir, ['--vs', 'latest~1'])
    assert.match(text, /policy change: the gate scores the same attempts differently/)
  })

  test('mixed outcomes over enough comparable attempts are flaky, caused by the agent', async () => {
    const p = await project('canary-flaky', {
      'reeval.config.ts': fakeConfig(),
      'evals/f.eval.ts': `import { evaluate } from 'reeval'
evaluate('flips', { runs: 6, gate: { passRate: 0.5 } }, async (c) => {
  await c.send('go')
  if (c.attempt.n % 2 === 0) throw new Error('every other attempt fails')
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const [flaky] = await query(p.dir, 'SELECT pass, counted, verdict, cause FROM flaky_cells')
    assert.deepEqual(flaky, { pass: 3, counted: 6, verdict: 'flaky', cause: 'agent' })
  })

  test('mixed outcomes one attempt short of the minimum are mixed, not flaky', async () => {
    const p = await project('canary-mixed', {
      'reeval.config.ts': fakeConfig(),
      'evals/f.eval.ts': `import { evaluate } from 'reeval'
evaluate('flips', { runs: 5, gate: { passRate: 0.4 } }, async (c) => {
  await c.send('go')
  if (c.attempt.n % 2 === 0) throw new Error('every other attempt fails')
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const [flaky] = await query(p.dir, 'SELECT pass, counted, verdict FROM flaky_cells')
    assert.deepEqual(flaky, { pass: 3, counted: 5, verdict: 'mixed' })
  })

  test('the same change passing and failing its check is caused by the check', async () => {
    const flips = (harness: string) => ({
      'reeval.config.ts': fakeConfig({ harness }),
      'evals/f.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('flips', { runs: 6, gate: { passRate: 0.5 } }, async (c) => {
  await c.send('go')
  expect(c.attempt.n % 2, 'a racy check').toBe(1)
})
`,
    })
    const same = await project('flaky-check', flips(`{ files: { 'out.txt': 'same' } }`))
    assert.equal((await runCli(same.dir)).code, 0)
    const [flaky] = await query(same.dir, 'SELECT pass, counted, cause FROM flaky_cells')
    assert.deepEqual(flaky, { pass: 3, counted: 6, cause: 'check' })
    // Twin: each attempt writes something else, so the agent's work differs and may be why.
    const differs = await project(
      'flaky-check-twin',
      flips(`{ script: [[{ exec: 'date +%s%N > out.txt' }]] }`),
    )
    assert.equal((await runCli(differs.dir)).code, 0)
    const [twin] = await query(differs.dir, 'SELECT cause FROM flaky_cells')
    assert.deepEqual(twin, { cause: 'agent' })
  })
})

describe('effort next to lift', () => {
  const sample = (tools: number, extra?: { tokens?: number; agentMs?: number }) => ({
    tools,
    agentMs: extra?.agentMs ?? 20_000,
    fileEdits: 1,
    ...(extra?.tokens !== undefined ? { tokens: extra.tokens } : {}),
  })

  test('the rank test is exact: 4 against 4, fully separated, is 2/70', () => {
    assert.deepEqual(mannWhitney([4, 5, 5, 6], [30, 40, 50, 60]), {
      p: 2 / 70,
      sign: -1,
      floor: 2 / 70,
    })
    assert.deepEqual(mannWhitney([3, 4], [1, 2]), { p: 1 / 3, sign: 1, floor: 1 / 3 })
    assert.equal(minimumP(2, 2), 1 / 3)
    const c = contrastEffort(
      [4, 5, 5, 6].map((tools) => sample(tools)),
      [30, 40, 50, 60].map((tools) => sample(tools, { agentMs: 45_000 })),
    )
    assert.ok(c)
    assert.equal(c.tokensVerdict, null)
    assert.equal(
      effortLabel(c),
      'tools 5 vs 45 (×0.11), agent 20s vs 45s (×0.44): fewer tool calls (p = 0.029)',
    )
  })

  test('tokens join the rank test when both sides reported usage', () => {
    const c = contrastEffort(
      [4, 5, 5, 6].map((tools) => sample(tools, { tokens: 100 })),
      [30, 40, 50, 60].map((tools) => sample(tools, { tokens: 1000, agentMs: 45_000 })),
    )
    assert.ok(c)
    assert.equal(c.tokensVerdict, 'fewer')
    assert.equal(c.tokensNote, undefined)
    assert.equal(
      effortLabel(c),
      'tools 5 vs 45 (×0.11), agent 20s vs 45s (×0.44), tokens 100 vs 1,000 (×0.10): fewer tool calls (p = 0.029); fewer tokens (p = 0.029)',
    )
  })

  test('a side with no usage omits the token metric, not insufficient', () => {
    const c = contrastEffort(
      [4, 5, 5, 6].map((tools) => sample(tools, { tokens: 100 })),
      [30, 40, 50, 60].map((tools) => sample(tools, { agentMs: 45_000 })),
    )
    assert.ok(c)
    assert.equal(c.verdict, 'fewer')
    assert.equal(c.tokensVerdict, null)
    assert.equal(c.tokensNote, 'some cells did not report usage')
    assert.equal(
      effortLabel(c),
      'tools 5 vs 45 (×0.11), agent 20s vs 45s (×0.44): fewer tool calls (p = 0.029)',
    )
  })

  test('tokens still verdict among cells that reported usage when another cell did not', () => {
    const cursor = contrastEffort(
      [4, 5, 5, 6].map((tools) => sample(tools, { tokens: 100 })),
      [30, 40, 50, 60].map((tools) => sample(tools, { tokens: 1000 })),
    )
    const goose = contrastEffort(
      [4, 5, 5, 6].map((tools) => sample(tools)),
      [30, 40, 50, 60].map((tools) => sample(tools)),
    )
    assert.equal(cursor?.tokensVerdict, 'fewer')
    assert.equal(goose?.tokensVerdict, null)
    assert.equal(goose?.verdict, 'fewer')
    assert.equal(goose?.tokensNote, undefined)
  })

  test('attempts without usage drop out of the token sample only', () => {
    const c = contrastEffort(
      [...[4, 5, 5, 6].map((tools) => sample(tools, { tokens: 100 })), sample(7)],
      [
        ...[30, 40, 50, 60].map((tools) => sample(tools, { tokens: 1000, agentMs: 45_000 })),
        sample(70, { agentMs: 45_000 }),
      ],
    )
    assert.ok(c)
    assert.equal(c.verdict, 'fewer')
    assert.equal(c.tokensVerdict, 'fewer')
    assert.equal(c.tokensNote, 'some cells did not report usage')
    assert.match(effortLabel(c), /tokens 100 vs 1,000/)
    assert.doesNotMatch(effortLabel(c), /insufficient/)
  })

  // A three-arm skill study's per-attempt values at 3 runs a cell: tools, tokens (k), agent (s).
  const arm = (tools: number[], tokensK: number[], agentS: number[]) =>
    tools.map((t, i) => ({
      tools: t,
      agentMs: (agentS[i] ?? 0) * 1000,
      fileEdits: 1,
      tokens: (tokensK[i] ?? 0) * 1000,
    }))
  const noSkill = arm([38, 55, 35], [908, 1117, 1094], [97, 110, 98])
  const current = arm([28, 26, 26], [576, 430, 394], [69, 59, 63])
  const fresh = arm([13, 19, 14], [221, 463, 279], [47, 69, 56])

  test('3 against 3 with no overlap on any metric is directional, never an effect', () => {
    const c = contrastEffort(current, noSkill)
    assert.ok(c)
    assert.deepEqual(
      [c.verdict, c.timeVerdict, c.tokensVerdict],
      ['insufficient', 'insufficient', 'insufficient'],
    )
    assert.deepEqual([c.separated, c.timeSeparated, c.tokensSeparated], [true, true, true])
    assert.deepEqual(directional(c), ['tools', 'agentS', 'tokens'])
    assert.equal(
      effortLabel(c),
      'tools 26 vs 38 (×0.68, no overlap), agent 1m 03s vs 1m 38s (×0.64, no overlap), tokens 430k vs 1,094k (×0.39, no overlap): too few attempts to test (n = 3 vs 3)',
    )
  })

  test('3 against 3 that overlaps says nothing beyond too few attempts', () => {
    const c = contrastEffort(fresh, current)
    assert.ok(c)
    assert.deepEqual([c.separated, c.timeSeparated, c.tokensSeparated], [true, false, false])
    assert.deepEqual(directional(c), ['tools'])
    assert.equal(
      effortLabel(c),
      'tools 14 vs 26 (×0.54, no overlap), agent 56s vs 1m 03s (×0.89), tokens 279k vs 430k (×0.65): too few attempts to test (n = 3 vs 3)',
    )
  })

  test('2 against 2 is never directional, separated or not', () => {
    const c = contrastEffort(current.slice(0, 2), noSkill.slice(0, 2))
    assert.ok(c)
    assert.equal(c.separated, true)
    assert.deepEqual(directional(c), [])
    assert.doesNotMatch(effortLabel(c), /no overlap/)
  })

  test('agent times both under a tenth of a second print <0.1s and no ratio', () => {
    const c = contrastEffort(
      [4, 5, 5].map((tools, i) => sample(tools, { agentMs: 10 + i })),
      [30, 40, 50].map((tools, i) => sample(tools, { agentMs: 30 + i })),
    )
    assert.ok(c)
    assert.deepEqual(directional(c), ['tools', 'agentS'])
    assert.equal(
      effortLabel(c),
      'tools 5 vs 40 (×0.13, no overlap), agent <0.1s vs <0.1s: too few attempts to test (n = 3 vs 3)',
    )
    const one = contrastEffort([sample(4, { agentMs: 20 })], [sample(30, { agentMs: 400 })])
    assert.ok(one)
    assert.match(effortLabel(one), /agent <0\.1s vs 0\.4s \(×0\.05\)/, 'one side over keeps it')
    const tally = (agentMs: number) => ({ tools: { median: 4 }, agentMs: { median: agentMs } })
    assert.equal(
      effortChangeLabel(tally(20), tally(40)),
      'tools 4 → 4 (×1.00) · agent <0.1s → <0.1s',
    )
    assert.equal(
      effortChangeLabel(tally(20), tally(400)),
      'tools 4 → 4 (×1.00) · agent <0.1s → 0.4s (×20.00)',
    )
  })

  test('effort needs 4 runs a cell to be testable', () => {
    assert.equal(EFFORT_MIN_RUNS, 4)
    assert.ok(minimumP(3, 3) >= 0.05)
    assert.ok(minimumP(4, 4) < 0.05)
  })

  test("tokens read the same everywhere: Ben's 430443 vs 1093952 is 430k vs 1,094k", () => {
    assert.equal(`${formatTokens(430_443)} vs ${formatTokens(1_093_952)}`, '430k vs 1,094k')
    assert.equal(formatTokens(9_512), '9,512')
    assert.equal(
      formatUsage({
        input: 726_000,
        output: 12_000,
        cacheRead: 663_000,
        cacheWrite: 0,
        reasoning: null,
      }),
      '1,389k in (663k cached) · 12k out',
    )
  })

  test('reeval run and summary.md print the arms without an effort table below four tries a side, and reeval compare -v still shows effort', async () => {
    const p = await project('effort-summary', {
      'reeval.config.ts': fakeConfig({ harness: "{ withSkill: { files: { 'ok.txt': 'y' } } }" }),
      'skills/s/SKILL.md': '---\nname: s\ndescription: A skill. Use when testing.\n---\nBody.\n',
      'evals/c.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const plain = defineEnvironment('plain', { sandbox })
const skilled = defineEnvironment('skilled', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/s')],
}))
evaluate('greets', { compare: { baseline: plain, variants: [skilled] }, runs: 2 }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
    })
    const first = await runCli(p.dir)
    assert.equal(first.code, 0, first.stdout)
    // Two tries a side is below the effort table's four, so only the arms print.
    assert.match(first.stdout, /^ {2}skilled {12}2 of 2 {2}can't tell yet$/m)
    assert.doesNotMatch(first.stdout, /^ {2}effort /m)
    const { read } = readRun(p.dir)
    assert.match(read('summary.md'), /^ {2}skilled {12}2 of 2 {2}can't tell yet$/m)
    assert.equal((await runCli(p.dir)).code, 0)
    const compare = await runCli(p.dir, ['compare', 'latest~1', 'latest', '-v'])
    assert.equal(compare.code, 0, compare.stderr)
    assert.match(
      compare.stdout,
      /\n {2}fake\/skilled\/fake +lift \+100 \(\+\d+…\+100\)( noise)? → \+100[^\n]* · tools \d+ → \d+/,
    )
    const plain = await runCli(p.dir, ['compare', 'latest~1', 'latest'])
    assert.doesNotMatch(plain.stdout, /lift|tools \d+ →/, 'statistics only with -v')
    const json = JSON.parse(
      (await runCli(p.dir, ['compare', 'latest~1', 'latest', '--json'])).stdout,
    )
    const skilled = json.rows[0].perCell.find((c: { key: string }) => c.key === 'fake/skilled/fake')
    assert.deepEqual([skilled.head.effort.n, skilled.head.lift.points], [2, 1])
  })

  test('reeval query effort verdicts tokens when usage is present and omits them when it is not', async () => {
    const p = await compareProject('effort-tokens-query', 4)
    assert.equal((await runCli(p.dir)).code, 0)
    const none = await query(
      p.dir,
      `SELECT tokens_median, tokens_verdict, tokens_note FROM effort WHERE role = 'variant'`,
    )
    assert.ok(none.length)
    assert.ok(
      none.every((r) => r.tokens_verdict === null && r.tokens_median === null),
      'fake harness reports no usage: omit tokens, do not say insufficient',
    )

    const history = join(p.dir, '.reeval/runs')
    const names = readdirSync(history).filter((n) => n.endsWith('.json'))
    assert.equal(names.length, 1)
    const path = join(history, names[0] as string)
    const record = JSON.parse(readFileSync(path, 'utf8')) as {
      evals: Array<{ attempts: Array<{ cell: string; usage: unknown }> }>
    }
    const usage = (n: number) => ({
      input: n,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: null,
    })
    for (const e of record.evals) {
      for (const a of e.attempts) {
        a.usage = a.cell.includes('/skilled/') ? usage(100) : usage(1000)
      }
    }
    writeFileSync(path, JSON.stringify(record))
    const rebuilt = await runCli(p.dir, [
      'query',
      `SELECT tokens_median, control_tokens_median, tokens_ratio, tokens_verdict, tokens_note FROM effort WHERE role = 'variant'`,
      '--json',
      '--rebuild',
    ])
    assert.equal(rebuilt.code, 0, rebuilt.stderr)
    const withUsage = JSON.parse(rebuilt.stdout) as Row[]
    assert.deepEqual(
      withUsage.map((r) => [
        r.tokens_median,
        r.control_tokens_median,
        r.tokens_ratio,
        r.tokens_verdict,
        r.tokens_note,
      ]),
      [[100, 1000, 0.1, 'fewer', null]],
    )
  })
})

describe('reeval CLI spec', () => {
  test('verify commands must parse as reeval commands with their own flags', () => {
    const tables = ['effort', 'lift']
    const ok = [
      'reeval query effort',
      'npx reeval run --record',
      'pnpm reeval compare latest~1 latest --md',
      'reeval analyze latest --vs latest~1 --json',
      'reeval analyze --vs none',
      'reeval run --tag smoke -vv',
      'reeval studio build --out site',
      'reeval image build --dry-run',
      `reeval query "SELECT * FROM effort WHERE verdict = 'fewer'"`,
      'reeval run --record && reeval query effort',
      'reeval query effort --run last',
      `reeval query "SELECT * FROM effort WHERE run_id = :run" --run last`,
    ]
    for (const c of ok) assert.equal(checkCommand(c, tables), null, c)
    const bad: Array<[string, RegExp]> = [
      ['npx reeval compare r1 r2 --include-efficiency', /--include-efficiency isn't a reeval flag/],
      ['reeval eval fix-config --debug-judge', /reeval eval isn't a reeval command/],
      ['reeval run --eval scaffold', /--eval isn't an option of reeval run/],
      ['reeval image build --tag smoke', /--tag isn't an option of reeval image build/],
      [
        'reeval query efficiency',
        /no view or table named efficiency \(views and tables: effort, lift\)/,
      ],
      ['reeval query effort --run', /--run needs a value/],
      ['reeval show latest --md --json extra', /takes at most 1 argument/],
      ['reeval run --runs', /--runs needs a value/],
      ['cat evals/x.ts', /isn't a reeval command/],
      ['reeval query effort | head', /pipes/],
    ]
    for (const [c, why] of bad) assert.match(checkCommand(c, tables) ?? '', why, c)
  })

  test('reeval run and reeval image build verify commands must select an eval of the run', () => {
    const evals = [
      {
        file: 'evals/skill.eval.ts',
        name: 'house greeting greets',
        tags: ['skill'],
        cells: ['fake/-', 'fake/with-skill'],
      },
      {
        file: 'evals/hello.eval.ts',
        name: 'greet module creates',
        tags: ['smoke'],
        cells: ['fake/-'],
      },
    ]
    const ok = [
      'reeval run --tag skill',
      'reeval run --tag !skill',
      'reeval run evals/skill.eval.ts --runs 6',
      'reeval run greets',
      'reeval run with-skill --tag skill',
      'reeval image build hello',
      'reeval query effort',
    ]
    for (const c of ok) assert.equal(checkCommand(c, ['effort'], evals), null, c)
    const bad: Array<[string, RegExp]> = [
      [
        'reeval run --runs 6 --tag nosuchtag',
        /reeval run --tag nosuchtag: no eval in the run has the tag nosuchtag \(tags: skill, smoke\)/,
      ],
      [
        'reeval run nosuchname',
        /reeval run: filter "nosuchname" matches no eval file, eval name or cell in the run/,
      ],
      [
        'reeval run hello.eval.ts --tag skill',
        /reeval run hello\.eval\.ts --tag skill selects no eval in the run/,
      ],
      ['reeval run --tag=nosuchtag', /reeval run --tag nosuchtag: no eval/],
      ['reeval image build nosuchname', /reeval image build: filter "nosuchname" matches no eval/],
      ['reeval run --record && reeval run --tag nope', /--tag nope: no eval/],
    ]
    for (const [c, why] of bad) assert.match(checkCommand(c, [], evals) ?? '', why, c)
    const withIds = evals.map((e) => ({
      ...e,
      id: `${e.file} › ${e.name}`,
    }))
    assert.equal(
      checkCommand(`reeval run '${withIds[0]?.id}'`, ['effort'], withIds),
      null,
      'reeval run <id> selects that eval',
    )
    assert.equal(
      checkCommand('reeval run --tag nosuchtag'),
      null,
      'without the run, only the syntax',
    )
  })

  test('the spec and reeval --help name the same commands and flags', async () => {
    const p = await project('cli-spec', { 'reeval.config.ts': fakeConfig() })
    const help = (await runCli(p.dir, ['--help'])).stdout
    for (const command of Object.keys(COMMANDS))
      assert.match(help, new RegExp(`\\n  reeval ${command}\\b`), command)
    const named = new Set([...help.matchAll(/--([a-z][a-z-]+)/g)].map((m) => m[1] as string))
    for (const flag of named)
      assert.ok(flag in FLAGS, `--${flag} in reeval --help isn't in the spec`)
    for (const flag of Object.keys(FLAGS))
      assert.ok(named.has(flag), `--${flag} isn't in reeval --help`)
  })
})

/** A canned model answer, some of it wrong on purpose; every call is counted in calls.log. */
const FAKE = `analysis: {
    model: fakeAnalysis({
      output: (d) => {
        appendFileSync(new URL('./calls.log', import.meta.url), 'call\\n')
        const good = d.facts.find((f) => f.kind === 'factor' && f.tier === 'pooled' && f.level === 'es-good' && f.eval === 'all evals')
        const failure = d.facts.find((f) => f.kind === 'failure')
        const sat = d.facts.find((f) => f.kind === 'saturation')
        const e1 = d.evidence[0]
        const line = e1.lines.find((l) => /^L\\d+ /.test(l)).split(' ')[0]
        const action = (verify, cites = [good.id]) => ({ title: 'Check ' + verify, target: 'evals/', kind: 'eval', change: 'c', expectedEffect: 'e', verify, impact: 'high', effort: 'low', cites })
        return {
          tldr: 'es-good cuts tool calls; pass-rate lift is within noise.',
          whatHappened: [
            { text: 'One control attempt failed its judge.', cites: [failure.attempt, failure.id], confidence: 'high' },
            { text: 'An attempt that never ran.', cites: ['r9/nope/control#1'], confidence: 'high' },
            { text: 'A line the evidence does not show.', cites: [e1.id + ':L9999'], confidence: 'low' },
          ],
          results: [
            { text: 'es-good: ×0.11 tool calls on scaffold, p = 0.0286, in 3 of 3 evals.', cites: [good.id], confidence: 'high' },
            { text: 'Tool calls fell by 77.', cites: [good.id], confidence: 'medium' },
          ],
          why: [
            { text: 'The agent said so.', cites: [e1.id + ':' + line], confidence: 'medium', quotes: ['Fixed.'] },
            { text: 'An invented quote.', cites: [e1.id], confidence: 'low', quotes: ['this text is nowhere'] },
          ],
          anomalies: [
            { text: 'Saturated evals.', kind: 'eval-design', cites: [sat.id] },
            { text: 'The control passed with 0.97.', kind: 'judge', cites: [failure.attempt] },
            { text: 'Near-threshold scores include 88.', kind: 'other', cites: [sat.id] },
          ],
          actions: [
            action('npx reeval compare r1 r2 --include-efficiency'),
            action('reeval query efficiency'),
            action('reeval run --runs 6 --tag nosuchtag'),
            action('reeval query effort'),
            action('reeval run --record', ['F999']),
          ],
          confidence: { overall: 'medium', why: 'n = 4 per cell per eval' },
        }
      },
    }),
  },`
const FAKE_IMPORTS =
  "import { appendFileSync } from 'node:fs'\nimport { fakeAnalysis } from 'reeval/judge'\n"

async function fakeProject(name: string) {
  const p = await historyProject(name, 'dogfood', FAKE)
  const config = join(p.dir, 'reeval.config.ts')
  writeFileSync(config, FAKE_IMPORTS + readFileSync(config, 'utf8'))
  return p
}

const calls = (dir: string) =>
  existsSync(join(dir, 'calls.log'))
    ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).length
    : 0

/** Every file under `dir`, with a hash of its bytes. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name)
    if (statSync(path).isFile())
      out.set(
        name.replaceAll(sep, '/'),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      )
  }
  return out
}

const HEAD = '20260926T104633Z_041aef3_ci_jzvq'
const BASE = '20260926T104130Z_60f3dc9_cursor-agent_92gs'

describe('reeval analyze', () => {
  test('the prompt and rules say insufficient lift is not measured', () => {
    assert.match(SYSTEM_PROMPT, /insufficient is not measured: never put it on a results line/)
    assert.match(RULES[0] ?? '', new RegExp(`fewer than ${EFFECT_MIN_COUNTED} counted attempts`))
  })

  test('the prompt and rules say missing usage omits tokens, not insufficient', () => {
    assert.match(SYSTEM_PROMPT, /a missing token metric is omitted, not insufficient/)
    assert.match(SYSTEM_PROMPT, /do not treat unreportedUsage as a result/)
    assert.match(RULES[2] ?? '', /never because a harness dropped usage/)
    assert.match(RULES[2] ?? '', /omitted \(no line, not insufficient\)/)
  })

  test('the prompt and rules say a changed eval is not an effect', () => {
    assert.match(SYSTEM_PROMPT, /first line says the eval changed/)
    assert.match(SYSTEM_PROMPT, /A lift is an effect only when sources match/)
    assert.match(SYSTEM_PROMPT, /mixed counts such as 6\/10 vs 8\/9 are not a results line/)
    assert.match(RULES[1] ?? '', /not comparable: the eval changed/)
    assert.match(RULES[1] ?? '', /Do not put those mixed counts on a results line/)
  })

  test('the prompt and rules say compare-question rates annotate only', () => {
    assert.match(SYSTEM_PROMPT, /Compare-question facts \(kind compare-question\) are annotation/)
    assert.match(SYSTEM_PROMPT, /never change pass, fail or the exit code/)
    assert.match(SYSTEM_PROMPT, /A vote's reason is the model's wording/)
    assert.ok(
      RULES.some(
        (r) =>
          r.includes('Compare-question win rates annotate') &&
          r.includes("A vote's reason is the model's wording"),
      ),
    )
  })

  test('the prompt asks for one sentence and does not self-rate checks', () => {
    assert.match(SYSTEM_PROMPT, /one sentence: what happened, how sure, why, next/)
    assert.match(SYSTEM_PROMPT, /Do not rate your own citation or command checks/)
    assert.match(SYSTEM_PROMPT, /cited judge score must be the recorded score/)
    assert.match(
      analysisSchema.shape.tldr.description ?? '',
      /One sentence: what happened, how sure, why, next/,
    )
  })

  test('the prompt tells the model only --tag values that appear, else reeval run <id>', () => {
    assert.match(SYSTEM_PROMPT, /A `--tag` value must appear on some eval's `tags`/)
    assert.match(SYSTEM_PROMPT, /reeval run <id>/)
    assert.match(SYSTEM_PROMPT, /do not invent a tag from the eval name/)
  })

  test('validation caps confidence when citations or commands fail', () => {
    const empty = { invalid: [] as string[], dropped: 0, invalidCommands: [] as string[] }
    assert.equal(capConfidence('high', empty), 'high')
    assert.equal(capConfidence('high', { ...empty, invalid: ['whatHappened[0]: F9'] }), 'medium')
    assert.equal(capConfidence('medium', { ...empty, invalid: ['whatHappened[0]: F9'] }), 'medium')
    assert.equal(capConfidence('high', { ...empty, dropped: 1 }), 'low')
    assert.equal(capConfidence('medium', { ...empty, dropped: 1 }), 'low')
    assert.equal(
      capConfidence('high', { ...empty, invalidCommands: ['reeval eval: not a command'] }),
      'low',
    )
    const pinned = pinnedAnalysis([
      {
        file: 'old.json',
        source: 'cached',
        doc: {
          createdAt: '2026-01-01T00:00:00.000Z',
          error: undefined,
          analysis: { tldr: 'Older.' },
        },
      },
      {
        file: 'new.json',
        source: 'saved',
        doc: {
          createdAt: '2026-01-02T00:00:00.000Z',
          error: undefined,
          analysis: { tldr: 'Newer sentence.' },
        },
      },
      {
        file: 'failed.json',
        source: 'cached',
        doc: {
          createdAt: '2026-01-03T00:00:00.000Z',
          error: 'the model is down',
          analysis: { tldr: '' },
        },
      },
    ] as Parameters<typeof pinnedAnalysis>[0])
    assert.deepEqual(
      [pinned?.file, pinned?.source, pinned?.doc.analysis.tldr],
      ['new.json', 'saved', 'Newer sentence.'],
    )
  })

  test('a rejected verify is dropped', () => {
    const evals = [
      {
        file: 'evals/sign-in.eval.ts',
        name: 'sign-in',
        id: 'evals/sign-in.eval.ts › sign-in',
        tags: [] as string[],
        cells: ['fake/-'],
      },
    ]
    const digest: AnalysisDigest = {
      digestVersion: 5,
      scope: { kind: 'run', head: 'r1', base: null, evals: null },
      frame: 'gate',
      runs: { r1: { runId: 'r1', commit: null, branch: null, status: 'complete', summary: '0/1' } },
      setup: {
        harnesses: ['fake'],
        judge: 'none threshold 0.7',
        environments: [],
        evals: [{ tag: 'sign-in', id: evals[0]?.id ?? '', task: 'sign in', tags: [] }],
      },
      rules: [],
      cli: [],
      instructions: null,
      attempts: {},
      facts: [{ id: 'F1', kind: 'pass@1' }],
      evidence: [],
      dropped: [],
    }
    const action = (verify: string) => ({
      title: 'Retry',
      target: 'evals/sign-in.eval.ts',
      kind: 'eval' as const,
      change: 'c',
      expectedEffect: 'e',
      verify,
      impact: 'high' as const,
      effort: 'low' as const,
      cites: ['F1'],
    })
    const base = {
      tldr: 'A run.',
      whatHappened: [] as [],
      results: [] as [],
      why: [] as [],
      anomalies: [] as [],
      confidence: { overall: 'high' as const, why: 'n = 1' },
    }
    const dropped = validateAnalysis(
      {
        ...base,
        actions: [
          action('reeval run --tag sign-in'),
          action('reeval run --tag nosuch'),
          action('reeval query nope'),
          action('reeval query effort'),
        ],
      },
      digest,
      ['effort'],
      evals,
    )
    assert.deepEqual(
      dropped.body.actions.map((a) => a.verify),
      ['reeval query effort'],
    )
    assert.equal(dropped.validation.dropped, 3)
    assert.equal(dropped.validation.invalidCommands.length, 3)
    assert.equal(dropped.body.confidence.overall, 'low')
  })

  test('the digest is facts with ids, evidence by rule, and the verdict rules; --context needs no key', async () => {
    const p = await historyProject('analyze-context', 'dogfood')
    const { text, digest } = await digestOf(p.dir)
    assert.match(text, new RegExp(`# reeval analysis context: ${HEAD} vs ${BASE}`))
    assert.match(text, /reeval query factor_effects/)
    golden('dogfood-digest-facts', digest.facts)
    const failure = digest.facts.find((f) => f.kind === 'failure')
    assert.equal(failure?.attempt, 'r2/fix-config/control#1')
    const e1 = digest.evidence[0]
    assert.equal(e1?.ref, 'attempt:r2/fix-config/control#1')
    assert.match(
      e1?.lines[0] ?? '',
      /^L39 text: Fixed\./,
      'the final message keeps its transcript line',
    )
    assert.ok(
      digest.evidence.some((e) => e.ref === 'attempt:r2/fix-config/control#2'),
      'and its passing twin',
    )
    assert.ok(digest.evidence.some((e) => e.ref.startsWith('tool-strip:r2/scaffold/es-good#')))
    const scoped = (await digestOf(p.dir, ['--eval', 'fix-config'])).digest
    assert.ok(Object.keys(scoped.attempts).every((id) => id.includes('/fix-config/')))
    assert.deepEqual(
      digest.setup?.evals.map((e) => e.tags),
      [[], [], []],
      'each eval lists its tags, even when it has none',
    )
  })

  test("the digest lists each eval's tags", async () => {
    const p = await project('analyze-eval-tags', {
      'reeval.config.ts': fakeConfig({ extra: "record: 'always'," }),
      'evals/sign-in.eval.ts': `import { evaluate } from 'reeval'
evaluate('sign-in', { tags: ['auth'] }, async (c) => {
  await c.send('go')
})
`,
      'evals/hello.eval.ts': `import { evaluate } from 'reeval'
evaluate('hello', async (c) => {
  await c.send('go')
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const { digest } = await digestOf(p.dir)
    const byTag = Object.fromEntries((digest.setup?.evals ?? []).map((e) => [e.tag, e.tags]))
    assert.deepEqual(byTag, { 'sign-in': ['auth'], hello: [] })
    assert.ok(digest.setup?.evals.every((e) => e.id.includes(e.tag)))
  })

  test('the digest includes compare-question answers: rates by cut, ties, error and no pairs', async () => {
    const p = await project('analyze-compare-answers', {
      'reeval.config.ts': fakeConfig({ extra: "record: 'always'," }),
    })
    cpSync(
      join(pkgRoot, 'test/fixtures/records/with-answers/evals/.history'),
      join(p.dir, 'evals/.history'),
      {
        recursive: true,
      },
    )
    const { digest } = await digestOf(p.dir, [
      '20260929T222130Z_fbc30c8_cursor-agent_33kp',
      '--vs',
      'none',
    ])
    const questions = digest.facts.filter((f) => f.kind === 'compare-question')
    assert.equal(questions.length, 4)
    const house = questions.find(
      (f) => f.question === 'Which greeting reads more like our house style?' && f.votes === 2,
    )
    const failed = questions.find((f) => f.error === 'Rate limit exceeded (429)')
    const none = questions.filter((f) => f.note)
    assert.ok(house)
    assert.equal(house.model, 'fake')
    assert.equal(house.votes, 2)
    assert.equal(house.ties, 0)
    assert.deepEqual(house.rates, [
      { cut: 'within', name: 'plain', wins: 0, n: 2 },
      { cut: 'within', name: 'with-house-greeting', wins: 2, n: 2 },
    ])
    assert.equal(house.error, undefined)
    assert.ok(failed)
    assert.deepEqual(
      { votes: failed.votes, ties: failed.ties, error: failed.error, note: failed.note },
      { votes: 0, ties: 0, error: 'Rate limit exceeded (429)', note: undefined },
    )
    assert.equal(none.length, 2)
    assert.ok(
      none.every(
        (f) =>
          f.votes === 0 &&
          f.error === undefined &&
          f.note === 'no pairs to judge: attempts that failed their checks are left out',
      ),
    )
    assert.ok(
      digest.rules.some((r) => r.includes('Compare-question win rates annotate')),
      'the digest carries the annotation rule',
    )
  })

  test('one counted attempt a side is insufficient lift, not a results verdict', async () => {
    const p = await compareProject('analyze-sparse-lift', 1)
    const run = await runCli(p.dir, ['run', '-v'])
    assert.equal(run.code, 0, run.stdout)
    assert.match(
      run.stdout,
      /^ {2}\S+ +1 of 1 {2}can't tell yet\n {4}difference \+100 points, 95% interval −12…\+100$/m,
      '-v still prints the interval',
    )
    const { digest } = await digestOf(p.dir)
    const pass = digest.facts.find((f) => f.kind === 'pass@1')
    const variant = (
      pass?.cells as Array<{ lift?: string; verdict?: string; cell: string }> | undefined
    )?.find((c) => c.lift)
    assert.deepEqual(
      { lift: variant?.lift, verdict: variant?.verdict },
      { lift: 'not enough attempts for lift (1 vs 1)', verdict: 'insufficient' },
    )
    assert.ok(
      digest.rules.some((r) => r.includes('not measured') && r.includes('never a results line')),
    )
    const controlled = await query(
      p.dir,
      "SELECT pass_verdict, variant_counted, control_counted FROM factor_effects WHERE tier = 'controlled'",
    )
    assert.deepEqual(
      controlled.map((r) => [r.pass_verdict, r.variant_counted, r.control_counted]),
      [['insufficient', 1, 1]],
    )
  })

  test('a changed eval is not comparable, not an effect', async () => {
    const p = await project('analyze-eval-changed', {
      'reeval.config.ts': fakeConfig({
        harness: "{ withSkill: { files: { 'ok.txt': 'y' } } }",
        extra: "record: 'always',",
      }),
      'skills/s/SKILL.md': '---\nname: s\ndescription: A skill. Use when testing.\n---\nBody.\n',
      'evals/c.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const plain = defineEnvironment('plain', { sandbox })
const skilled = defineEnvironment('skilled', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/s')],
}))
evaluate('greets', { compare: { baseline: plain, variants: [skilled] }, runs: 2 }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    writeFileSync(
      join(p.dir, 'evals/c.eval.ts'),
      `import { defineEnvironment, evaluate } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const sandbox = fakeSandbox()
const plain = defineEnvironment('plain', { sandbox })
const skilled = defineEnvironment('skilled', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/s')],
}))
evaluate('greets', { compare: { baseline: plain, variants: [skilled] }, runs: 2 }, async (c) => {
  await c.send('go now')
})
`,
    )
    assert.equal((await runCli(p.dir)).code, 0)
    const observed = await query(
      p.dir,
      "SELECT factor, pass_verdict, note, variant_counted, control_counted FROM factor_effects WHERE tier = 'observed'",
    )
    assert.ok(observed.length > 0, 'sources drift is an observed factor')
    assert.ok(
      observed.every((r) => r.factor === 'sources' && r.pass_verdict === 'not_comparable'),
      JSON.stringify(observed),
    )
    assert.ok(observed.every((r) => String(r.note).includes('the eval changed')))
    const pooled = await query(p.dir, "SELECT * FROM factor_effects WHERE tier = 'pooled'")
    assert.equal(
      pooled.length,
      0,
      `pooled rows must not straddle an eval-changed pair: ${JSON.stringify(pooled)}`,
    )
    const implicit = await digestOf(p.dir)
    assert.ok(
      implicit.digest.facts.some((f) => f.kind === 'eval-changed'),
      'analyze with no --vs still sees the previous recorded run',
    )
    const { digest, text } = await digestOf(p.dir, ['--vs', 'latest~1'])
    assert.match(text, /not comparable: the eval changed/)
    const changed = digest.facts.filter((f) => f.kind === 'eval-changed')
    assert.equal(changed.length, 1)
    assert.match(String(changed[0]?.note), /not an effect of the thing under test/)
    const sources = digest.facts.filter((f) => f.kind === 'factor' && f.factor === 'sources')
    assert.ok(sources.length > 0)
    assert.ok(
      sources.every(
        (f) =>
          f.passVerdict === 'not comparable' &&
          f.lift === 'not comparable: the eval changed' &&
          !('passRate' in f),
      ),
      JSON.stringify(sources),
    )
    assert.ok(
      !digest.facts.some((f) => f.kind === 'factor' && f.tier === 'pooled'),
      'a pooled row must not straddle the eval-changed pair',
    )
    assert.ok(digest.rules.some((r) => r.includes('the eval changed')))
  })

  test('a changed eval has no mixed 6/10 vs 8/9 result line', async () => {
    const evalFile = (
      prompt: string,
      runs: number,
      failFrom: number,
    ) => `import { evaluate } from 'reeval'
evaluate('greets', { runs: ${runs}, gate: { passRate: 0.5 } }, async (c) => {
  await c.send(${JSON.stringify(prompt)})
  if (c.attempt.n >= ${failFrom}) throw new Error('counted miss')
})
`
    const p = await project('analyze-eval-changed-mixed-rate', {
      'reeval.config.ts': fakeConfig({ extra: "record: 'always'," }),
      'evals/c.eval.ts': evalFile('go', 9, 9),
    })
    assert.equal((await runCli(p.dir)).code, 0)
    writeFileSync(join(p.dir, 'evals/c.eval.ts'), evalFile('go now', 10, 7))
    assert.equal((await runCli(p.dir)).code, 0)
    const observed = await query(
      p.dir,
      "SELECT variant_pass, variant_counted, control_pass, control_counted, pass_verdict FROM factor_effects WHERE tier = 'observed'",
    )
    assert.ok(
      observed.some(
        (r) =>
          r.variant_pass === 6 &&
          r.variant_counted === 10 &&
          r.control_pass === 8 &&
          r.control_counted === 9 &&
          r.pass_verdict === 'not_comparable',
      ),
      `sources drift is 6/10 vs 8/9, not comparable: ${JSON.stringify(observed)}`,
    )
    const pooled = await query(p.dir, "SELECT * FROM factor_effects WHERE tier = 'pooled'")
    assert.equal(pooled.length, 0, `no pooled row straddles the pair: ${JSON.stringify(pooled)}`)
    const { digest } = await digestOf(p.dir, ['--vs', 'latest~1'])
    assert.ok(
      digest.facts.some((f) => f.kind === 'eval-changed'),
      'digest has the eval-changed fact',
    )
    const resultLines = digest.facts.flatMap((f) => [
      ...(typeof f.passRate === 'string' ? [f.passRate] : []),
      ...(typeof f.lift === 'string' ? [f.lift] : []),
    ])
    assert.ok(
      !resultLines.includes('6/10 vs 8/9'),
      `mixed pass-rate is not a result line: ${JSON.stringify(resultLines)}`,
    )
    assert.ok(
      !JSON.stringify(digest.facts).includes('6/10 vs 8/9'),
      'the mixed rate is not on any digest fact',
    )
    assert.ok(
      !digest.facts.some((f) => f.kind === 'factor' && f.tier === 'pooled'),
      'digest emits no pooled factor that straddles the eval-changed pair',
    )
  })

  test('--vs none analyses this run only, with no ancestor', async () => {
    const p = await project('analyze-vs-none', {
      'reeval.config.ts': fakeConfig({ extra: "record: 'always'," }),
      'evals/c.eval.ts': `import { evaluate } from 'reeval'
evaluate('greets', { runs: 1 }, async (c) => {
  await c.send('go')
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    writeFileSync(
      join(p.dir, 'evals/c.eval.ts'),
      `import { evaluate } from 'reeval'
evaluate('greets', { runs: 1 }, async (c) => {
  await c.send('go now')
})
`,
    )
    assert.equal((await runCli(p.dir)).code, 0)
    assert.ok(
      (await digestOf(p.dir)).digest.facts.some((f) => f.kind === 'eval-changed'),
      'the default still compares with the ancestor',
    )
    const self = await runCli(p.dir, ['analyze', '--vs', 'latest'])
    assert.equal(self.code, 2, 'the run against itself')
    assert.match(self.stderr, /reeval analyze --vs names the run itself/)
    const { text, digest } = await digestOf(p.dir, ['--vs', 'none'])
    assert.match(text.split('\n')[0] ?? '', /^# reeval analysis context: \S+$/)
    assert.equal(digest.scope.base, null)
    const kinds = digest.facts.map((f) => f.kind)
    assert.ok(
      !kinds.some((k) => ['eval-changed', 'drift', 'compare'].includes(k)),
      `--vs none keeps no compare facts: ${kinds.join(', ')}`,
    )
    assert.ok(
      !digest.facts.some(
        (f) => f.kind === 'factor' && (f.tier === 'pooled' || f.tier === 'observed'),
      ),
      '--vs none keeps no cross-run factor rows',
    )
    const dry = await runCli(p.dir, ['analyze', '--vs', 'none', '--dry-run'])
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout.split('\n')[0] ?? '', /^digest \S+: /)
    assert.doesNotMatch(dry.stdout.split('\n')[0] ?? '', / vs /)
  })

  for (const [runs, effect, lift, verdict] of [
    [2, "can't tell yet", 'not enough attempts for lift (2 vs 2)', 'insufficient'],
    [3, "can't tell yet", 'not enough attempts for lift (3 vs 3)', 'insufficient'],
    [4, 'helped', '+100 pts (95% +31…+100)', 'effect'],
  ] as const) {
    test(`${runs} against ${runs}: every view gives the same verdict`, async () => {
      const p = await compareProject(`analyze-lift-${runs}`, runs)
      const run = await runCli(p.dir)
      assert.equal(run.code, 0, run.stdout)
      assert.match(run.stdout, new RegExp(`^ {2}\\S+ +${runs} of ${runs} {2}${effect}$`, 'm'))
      const { digest } = await digestOf(p.dir)
      const pass = digest.facts.find((f) => f.kind === 'pass@1')
      const variant = (pass?.cells as Array<{ lift?: string; verdict?: string }> | undefined)?.find(
        (c) => c.lift,
      )
      assert.deepEqual({ lift: variant?.lift, verdict: variant?.verdict }, { lift, verdict })
      const effort = digest.facts.find((f) => f.kind === 'effort')
      assert.deepEqual(
        (effort?.cells as Row[] | undefined)?.map((c) => [c.medianToolCalls, c.medianCallsByClass]),
        [
          [0, undefined],
          [0, undefined],
        ],
        'no tool calls: no class breakdown',
      )
      const [row] = await query(
        p.dir,
        "SELECT pass_verdict FROM factor_effects WHERE tier = 'controlled'",
      )
      assert.equal(row?.pass_verdict, verdict)
    })
  }

  test('every view reads one minimum of counted attempts', async () => {
    const stats = await import('../src/stats.ts')
    const suite = await import('../src/view/suite.ts')
    const view = await import('../src/view/index.ts')
    assert.equal(stats.EFFECT_MIN_COUNTED, 4)
    assert.equal(suite.EFFECT_MIN_COUNTED, stats.EFFECT_MIN_COUNTED)
    assert.equal(view.EFFECT_MIN_COUNTED, stats.EFFECT_MIN_COUNTED)
    const src = join(import.meta.dirname, '../src')
    const defines = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\bconst \w*MIN_COUNTED\b/.test(readFileSync(join(src, f), 'utf8')))
    assert.deepEqual(defines, ['stats.ts'], 'one definition, which every view imports')
  })

  test('claims with invented citations or quotes are dropped; invented CLI flags are rejected', async () => {
    const p = await fakeProject('analyze-validate')
    const r = await runCli(p.dir, ['analyze', '--json'])
    assert.equal(r.code, 0, r.stderr)
    const doc = JSON.parse(r.stdout)
    assert.deepEqual(
      [doc.scope.head, doc.scope.base, doc.anchor, doc.route],
      [HEAD, BASE, HEAD, 'fake'],
    )
    const a = doc.analysis
    assert.deepEqual(
      a.whatHappened.map((c: { text: string }) => c.text),
      ['One control attempt failed its judge.'],
    )
    assert.deepEqual(
      a.why.map((c: { text: string }) => c.text),
      ['The agent said so.'],
    )
    assert.deepEqual(
      a.results[1].unverifiedNumbers,
      ['77'],
      'a number no cited fact holds is flagged',
    )
    assert.equal(a.results[0].unverifiedNumbers, undefined)
    assert.deepEqual(
      a.anomalies.map((x: { text: string }) => x.text),
      ['Saturated evals.', 'Near-threshold scores include 88.'],
      'a cited judge score that is not in the record is dropped',
    )
    assert.deepEqual(a.anomalies[1].unverifiedNumbers, ['88'])
    assert.deepEqual(
      a.actions.map((x: { verify: string | null }) => x.verify),
      ['reeval query effort'],
      'rejected verifies are dropped; the action citing only F999 is dropped',
    )
    assert.equal(a.actions[0].verifyProblem, undefined)
    const v = doc.validation
    assert.deepEqual([v.dropped, v.commands, v.invalidCommands.length], [8, 4, 3])
    assert.deepEqual(
      v.invalid.filter((x: string) => !x.includes('quote') && !x.includes("isn't in the cited")),
      [
        'whatHappened[1]: r9/nope/control#1',
        'whatHappened[2]: E1:L9999',
        "anomalies[1]: 0.97 isn't the cited judge score (0.1)",
        'actions[4]: F999',
      ],
    )
    assert.match(doc.cited['r2/fix-config/control#1'], /fail/)
    assert.deepEqual(doc.attempts['r2/fix-config/control#1'], {
      runId: HEAD,
      evalSlug: 'evals-fix-config-es-ts-broken-project-fixes-a-broken-config-854800',
      attempt: 'cursor:composer-2.5/broken-project/es-tarball#1',
    })
    const text = await runCli(p.dir, ['analyze'])
    assert.doesNotMatch(text.stdout, /verify: none/)
    assert.match(text.stdout, /verify: reeval query effort/)
    assert.match(
      text.stdout,
      /16 citations checked, 5 invalid, 8 dropped · 4 commands checked, 3 rejected/,
    )
    assert.equal(a.confidence.overall, 'low', 'dropped claims and rejected commands cap to low')
    assert.match(text.stdout, /^TL;DR \(low\) {2}/m)
  })

  test('an anomaly that quotes a judge score the record does not have is dropped', () => {
    const attempt = 'r1/greets/control#1'
    const digest: AnalysisDigest = {
      digestVersion: 3,
      scope: { kind: 'run', head: 'run1', base: null, evals: null },
      frame: 'gate',
      runs: {},
      setup: { harnesses: [], judge: '', environments: [], evals: [] },
      rules: RULES,
      cli: [],
      instructions: null,
      attempts: {
        [attempt]: {
          run: 'r1',
          runId: 'run1',
          key: 'k',
          eval: 'greets',
          evalSlug: 'greets',
          cell: 'control',
          attempt: 'fake/greets/control#1',
          outcome: 'pass',
          tools: 1,
          agentS: 1,
          judges: { tidy: 0.87 },
          execs: 1,
          artifacts: null,
        },
      },
      facts: [
        {
          id: 'F1',
          kind: 'failure',
          attempt,
          judges: [{ label: 'tidy', question: 'Is it tidy?', score: 0.87, threshold: 0.8 }],
        },
        { id: 'F2', kind: 'saturation', evals: [], saturated: ['greets'] },
      ],
      evidence: [
        {
          id: 'E1',
          ref: `attempt:${attempt}`,
          why: 'a failing attempt',
          lines: ['judge score: 0.87 (threshold 0.8)'],
          priority: 1,
        },
      ],
      dropped: [],
    }
    const blank = {
      tldr: 'A run.',
      whatHappened: [] as [],
      results: [] as [],
      why: [] as [],
      actions: [] as [],
      confidence: { overall: 'high' as const, why: 'n = 1' },
    }
    const wrong = validateAnalysis(
      {
        ...blank,
        anomalies: [{ text: 'The attempt passed with 0.97.', kind: 'judge', cites: [attempt] }],
      },
      digest,
      [],
    )
    assert.deepEqual(wrong.body.anomalies, [])
    assert.deepEqual(wrong.validation.invalid, [
      "anomalies[0]: 0.97 isn't the cited judge score (0.87)",
    ])
    assert.equal(wrong.validation.dropped, 1)
    assert.equal(wrong.body.confidence.overall, 'low')

    const matched = validateAnalysis(
      {
        ...blank,
        anomalies: [{ text: 'The attempt passed with 0.87.', kind: 'judge', cites: [attempt] }],
      },
      digest,
      [],
    )
    assert.deepEqual(
      matched.body.anomalies.map((a) => a.text),
      ['The attempt passed with 0.87.'],
    )
    assert.equal(matched.body.anomalies[0]?.unverifiedNumbers, undefined)
    assert.equal(matched.validation.dropped, 0)

    const flagged = validateAnalysis(
      {
        ...blank,
        anomalies: [{ text: 'Near-threshold scores include 88.', kind: 'other', cites: ['F2'] }],
      },
      digest,
      [],
    )
    assert.deepEqual(flagged.body.anomalies[0]?.unverifiedNumbers, ['88'])
    assert.equal(flagged.validation.dropped, 0)
    assert.equal(flagged.body.anomalies[0]?.text, 'Near-threshold scores include 88.')

    const fromFact = validateAnalysis(
      {
        ...blank,
        anomalies: [{ text: 'The attempt passed with 0.97.', kind: 'judge', cites: ['F1'] }],
      },
      digest,
      [],
    )
    assert.deepEqual(fromFact.body.anomalies, [])
    assert.match(
      fromFact.validation.invalid[0] ?? '',
      /isn't the cited judge score \(0\.87, 0\.8\)/,
    )

    const noJudge = validateAnalysis(
      {
        ...blank,
        anomalies: [{ text: 'Something scored 0.97.', kind: 'other', cites: ['F2'] }],
      },
      digest,
      [],
    )
    assert.equal(noJudge.body.anomalies[0]?.text, 'Something scored 0.97.')
    assert.deepEqual(noJudge.body.anomalies[0]?.unverifiedNumbers, ['0.97'])
    assert.equal(noJudge.validation.dropped, 0)
  })

  test('a cached analysis makes no call; --no-cache does', async () => {
    const p = await fakeProject('analyze-cache')
    assert.equal((await runCli(p.dir, ['analyze'])).code, 0)
    assert.equal(calls(p.dir), 1)
    const again = await runCli(p.dir, ['analyze', '--md'])
    assert.equal(again.code, 0, again.stderr)
    assert.equal(calls(p.dir), 1, 'the cache answered')
    assert.match(again.stderr, /cached analysis from/)
    assert.match(again.stdout, /^## reeval analysis · /)
    assert.equal(readdirSync(join(p.dir, '.reeval/analysis')).length, 1)
    const dry = await runCli(p.dir, ['analyze', '--dry-run'])
    assert.match(dry.stdout, /cache hit/)
    assert.match(dry.stdout, /≈ \d+ tokens \(cap 20000 in, 8000 out\)/)
    assert.doesNotMatch(again.stdout + dry.stdout, /\$\d|USD/, 'tokens only, never dollars')
    assert.equal((await runCli(p.dir, ['analyze', '--no-cache'])).code, 0)
    assert.equal(calls(p.dir), 2)
    assert.equal(
      (await runCli(p.dir, ['analyze', '--vs', 'latest'])).code,
      2,
      'the run against itself',
    )
  })

  test('--save writes two new files under <run>/analysis/ and nothing else; it never overwrites', async () => {
    const p = await fakeProject('analyze-save')
    const history = join(p.dir, 'evals/.history')
    const before = tree(history)
    const r = await runCli(p.dir, ['analyze', '--save'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stderr,
      /saved evals\/\.history\/.+\/analysis\/.+\.json and .+\.md\. Commit them with git\./,
    )
    const after = tree(history)
    const added = [...after.keys()].filter((k) => !before.has(k))
    assert.equal(added.length, 2)
    assert.ok(
      added.every((f) =>
        new RegExp(`^${HEAD}/analysis/\\d{8}T\\d{6}Z_[a-z0-9-]+_[0-9a-f]{8}\\.(json|md)$`).test(f),
      ),
      added.join(', '),
    )
    for (const [file, hash] of before) assert.equal(after.get(file), hash, `${file} is untouched`)
    assert.equal(readdirSync(join(p.dir, '.reeval/analysis')).length, 1, 'the cache has it too')

    const twice = await runCli(p.dir, ['analyze', '--save'])
    assert.equal(twice.code, 2)
    assert.match(twice.stderr, /is already saved for .+\. Saved analyses are never rewritten\./)
    assert.deepEqual([...tree(history).keys()].sort(), [...after.keys()].sort())

    // The studio shows saved and cached analyses live, and saved ones in a static build.
    const app = createStudioApp({
      source: { root: p.dir, historyDir: history, scratch: false },
      app: new Map(),
      reeval: 'test',
      project: 'analysis',
      token: null,
      hosts: [],
    })
    const live = await (await app.request(`http://x/${analysisDataPath(HEAD)}`)).json()
    assert.deepEqual(
      live.entries.map((e: { source: string }) => e.source),
      ['saved', 'cached'],
    )
    const none = await (await app.request(`http://x/${analysisDataPath(BASE)}`)).json()
    assert.deepEqual(none.entries, [])
    const out = join(p.dir, 'site')
    assert.equal((await runCli(p.dir, ['studio', 'build', '--out', out])).code, 0)
    const built = JSON.parse(readFileSync(join(out, analysisDataPath(HEAD)), 'utf8'))
    assert.deepEqual(
      built.entries.map((e: { source: string }) => e.source),
      ['saved'],
    )
    assert.equal(existsSync(join(out, analysisDataPath(BASE))), false)
  })

  test('without a language model or its key, it exits 2 and points at --context', async () => {
    const cases: Array<[string, RegExp]> = [
      [
        '',
        /reeval analyze needs a language model\. Set analysis: \{ model: 'google\/gemini-3\.8-flash' \}.*reeval analyze --context/,
      ],
      [
        "analysis: { model: 'typesafe-ai/jev-1.14.0' },",
        /analysis\.model in reeval\.config\.ts is "typesafe-ai\/jev-1\.14\.0", an evaluation model: it scores yes\/no questions/,
      ],
      [
        "analysis: { model: 'google/gemini-3.8-flash' },",
        /No credentials for analysis model "google\/gemini-3\.8-flash" \(provider "google"\)\. Set GOOGLE_GENERATIVE_AI_API_KEY.*--context, which needs no key/,
      ],
      [
        "analysis: { model: 'gemini' },",
        /analysis\.model in reeval\.config\.ts needs a provider prefix, e\.g\. "google\/gemini" \(got "gemini"\)/,
      ],
      [
        'analysis: { maxInputTokens: 10 },',
        /analysis\.maxInputTokens in reeval\.config\.ts must be a whole number of at least 1000 \(got 10\)/,
      ],
      [
        'analysis: { maxOutputTokens: 10 },',
        /analysis\.maxOutputTokens in reeval\.config\.ts must be a whole number of at least 500 \(got 10\)/,
      ],
      [
        'analysis: { maxCostUsd: 0.25 },',
        /Unknown option "maxCostUsd" in analysis in reeval\.config\.ts/,
      ],
    ]
    for (const [analysis, message] of cases) {
      const p = await historyProject('analyze-errors', 'dogfood', analysis)
      const r = await runCli(p.dir, ['analyze'])
      assert.equal(r.code, 2, analysis)
      assert.match(r.stderr, message, analysis)
    }
    const p = await fakeProject('analyze-scratch')
    const later = '20260926T120000Z_041aef3_ci_abcd'
    const record = JSON.parse(readFileSync(join(p.dir, 'evals/.history', `${HEAD}.json`), 'utf8'))
    mkdirSync(join(p.dir, '.reeval/runs'), { recursive: true })
    writeFileSync(
      join(p.dir, '.reeval/runs', `${later}.json`),
      JSON.stringify({ ...record, runId: later }),
    )
    const r = await runCli(p.dir, ['analyze', 'latest', '--save'])
    assert.equal(r.code, 2)
    assert.match(
      r.stderr,
      /isn't recorded, so there's no history folder to save into\. Run reeval record/,
    )
  })
})

/** A study's digest: the run, then `reeval analyze --context` on it alone. */
async function studyDigest(name: string, options: StudyOptions = {}) {
  const p = await project(name, studyFiles(options))
  const run = await runCli(p.dir)
  assert.equal(run.code, options.gate === 'none' ? 0 : 1, run.stdout + run.stderr)
  return { p, run, ...(await digestOf(p.dir, ['--vs', 'none'])) }
}

describe('a study: several arms, every cell ungated', () => {
  test('labels and names: judges and checks go by their expect label, and the control by its environment', async () => {
    const files = studyFiles({ gate: 'none' })
    const script =
      "node -e \"\\n  const fs = require('fs')\\n  process.exit(fs.statSync('src/App.tsx').size ? 0 : 1)\\n\""
    files['evals/auth.eval.ts'] = (files['evals/auth.eval.ts'] as string).replace(
      "c.exec('test -s src/App.tsx')",
      `c.exec(${JSON.stringify(script)}.replaceAll('\\\\n', '\\n'))`,
    )
    const p = await project('study-labels', files)
    const run = await runCli(p.dir)
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const show = await runCli(p.dir, ['show'])
    // Judges go by their expect labels, a column per arm, the control by its environment.
    assert.match(
      show.stdout,
      /^ {2}check {14}no-skill {2}current-skill {2}new-skill\n {2}Social OAuth {7}3 of 3 {4}0 of 3 {9}3 of 3\n {4}judge score 0\.12 is below 0\.8 for "Does it implement social sign-in\?" \(fake\)$/m,
      'the control names its judges by their expect labels',
    )
    assert.match(show.stdout, /^ {2}MFA {16}0 of 3 /m)
    assert.doesNotMatch(show.stdout, /…social sign-in|Does it upgrade an…/, 'no clipped question')
    const summary = readRun(p.dir).read('summary.md')
    assert.match(
      summary,
      /^- Check build exit 0: `node -e " …`/m,
      'the label, and the script on one line',
    )
    assert.match(
      summary,
      /^- Judge MFA \*\*fail\*\* 0\.12 \(threshold 0\.8, fake\): Does it implement/m,
    )
    const { digest } = await digestOf(p.dir, ['--vs', 'none'])
    const pass = digest.facts.find((f) => f.kind === 'pass@1') as { cells: Array<{ cell: string }> }
    assert.deepEqual(
      pass.cells.map((c) => c.cell),
      ['no-skill (control)', 'current-skill', 'new-skill'],
    )
    assert.ok(
      Object.keys(digest.attempts).includes('r1/auth/control#1'),
      'attempt ids keep the tag',
    )
  })

  test('the digest frames it as a study: criteria say what differs, never-met labels once, evidence for every arm', async () => {
    const { p, digest, text } = await studyDigest('study-digest', {
      gate: 'none',
      instructions: 'Compare both skills against no skill and against each other.',
      output: `(d) => {
        const criteria = d.facts.find((f) => f.kind === 'criteria')
        return { tldr: criteria.rows.map((r) => r.label).join(', ') + ' separates the arms; ' + criteria.neverMet.join(' and ') + ' are never met in any arm.', whatHappened: [{ text: 'Social OAuth separates the arms.', cites: [criteria.id], confidence: 'high' }], results: [], why: [], anomalies: [], actions: [], confidence: { overall: 'medium', why: 'n = 3' } }
      }`,
    })
    const d = digest as Digest & { frame: string }
    assert.equal(d.frame, 'study')
    const criteria = digest.facts.find((f) => f.kind === 'criteria')
    assert.deepEqual(criteria?.rows, [
      {
        label: 'Social OAuth',
        cells: {
          'no-skill (control)': '3/3 · 0.94',
          'current-skill': '0/3 · 0.12',
          'new-skill': '3/3 · 0.94',
        },
      },
    ])
    assert.deepEqual(criteria?.neverMet, ['Anonymous upgrade', 'MFA'])
    assert.deepEqual(criteria?.alwaysMet, ['build', 'Email sign-in'])
    const judge = digest.facts.find((f) => f.kind === 'judge')
    assert.equal(judge?.verdicts, 36)
    assert.equal(judge?.failures, undefined, 'which labels failed where is in criteria')
    const use = digest.facts.find((f) => f.kind === 'context-use') as
      | { cells: Array<{ cell: string; perAttempt: Record<string, string> }> }
      | undefined
    const perAttempt = Object.fromEntries((use?.cells ?? []).map((c) => [c.cell, c.perAttempt]))
    assert.equal(
      perAttempt['no-skill (control)']?.dependency,
      '1 1 1',
      'no skill: it reads the package types',
    )
    assert.equal(perAttempt['new-skill']?.context, '1 1 1', 'the new skill: its React reference')
    assert.equal(perAttempt['no-skill (control)']?.context, undefined)
    const effort = digest.facts.find((f) => f.kind === 'effort') as
      | { cells: Array<{ vsControl?: { n: string; separated?: Record<string, boolean> } }> }
      | undefined
    const vs = effort?.cells.flatMap((c) => (c.vsControl ? [c.vsControl] : [])) ?? []
    assert.equal(vs.length, 2)
    for (const v of vs as Array<{ n: string; agentS?: string }>) {
      assert.equal(v.n, '3 vs 3')
      assert.doesNotMatch(v.agentS ?? '', /^0 vs 0 /, 'two sub-50 ms medians have no ratio')
      assert.deepEqual(Object.keys(v.separated ?? {}).slice(0, 2), ['tools', 'agentS'])
    }
    const current = digest.attempts['r1/auth/current-skill#1']
    assert.deepEqual(
      [current?.checks, current?.failed, current?.judges, current?.execs],
      [
        '2/5',
        ['Social OAuth', 'Anonymous upgrade', 'MFA'],
        { 'Email sign-in': 0.94, 'Social OAuth': 0.12, 'Anonymous upgrade': 0.12, MFA: 0.12 },
        1,
      ],
    )
    const failures = digest.facts.filter((f) => f.kind === 'failure')
    assert.deepEqual(
      failures.map((f) => f.attempt),
      ['r1/auth/control#1', 'r1/auth/current-skill#1', 'r1/auth/new-skill#1'],
      'one failure per arm, not eight from the first',
    )
    assert.deepEqual(failures[1]?.failed, ['Social OAuth', 'Anonymous upgrade', 'MFA'])
    assert.deepEqual(
      digest.evidence.filter((e) => e.ref.startsWith('attempt:')).map((e) => e.ref),
      [
        'attempt:r1/auth/control#1',
        'attempt:r1/auth/current-skill#1',
        'attempt:r1/auth/new-skill#1',
      ],
      'evidence for every arm, the current skill failing the label that separates it',
    )
    assert.ok(
      digest.evidence[1]?.lines.includes('judge Social OAuth: Does it implement social sign-in?'),
    )
    assert.match(text, /This run is a study: every cell is ungated/)
    assert.ok(
      text.indexOf('## Project instructions') < text.indexOf('## How reeval decided'),
      'the project instructions come before the rules',
    )
    const analyzed = await runCli(p.dir, ['analyze', '--vs', 'none'])
    assert.equal(analyzed.code, 0, analyzed.stderr)
    assert.match(
      analyzed.stdout,
      /Social OAuth separates the arms; Anonymous upgrade and MFA are never met in any arm\./,
    )
  })

  test('canary: the same arms with gated variants are not a study', async () => {
    const { digest, text } = await studyDigest('study-gated', { gate: 'variants' })
    assert.equal((digest as Digest & { frame: string }).frame, 'gate')
    assert.doesNotMatch(text, /This run is a study/)
    assert.equal(
      digest.facts.filter((f) => f.kind === 'failure').length,
      8,
      'a gate lists up to eight failures',
    )
  })
})

test('the prompt and rules say a study compares arms, and a label no arm meets explains nothing', () => {
  assert.match(SYSTEM_PROMPT, /When the digest's frame is study/)
  assert.match(SYSTEM_PROMPT, /never make one a why/)
  assert.match(SYSTEM_PROMPT, /setup, rules and cli are context, not citable/)
  assert.ok(RULES.some((r) => r.includes("can't explain a difference between arms")))
  assert.ok(RULES.some((r) => r.startsWith('frame study means')))
})

describe('contrasts: each pair of arms, variant against variant too', () => {
  test('show, summary.md and the run set every arm side by side, and reeval query contrasts and the digest every pair', async () => {
    const p = await project('study-contrasts', studyFiles({ gate: 'none' }))
    const run = await runCli(p.dir)
    assert.equal(run.code, 0, run.stdout + run.stderr)
    // Every attempt misses MFA, so pass can't tell the arms apart; the check matrix does.
    const matrix =
      /^ {2}check {14}no-skill {2}current-skill {2}new-skill\n {2}Social OAuth {7}3 of 3 {4}0 of 3 {9}3 of 3$/m
    assert.match(run.stdout, matrix)
    assert.match((await runCli(p.dir, ['show'])).stdout, matrix)
    assert.match(readRun(p.dir).read('summary.md'), matrix)
    const rows = await query(
      p.dir,
      'SELECT a_environment, b_environment, a_pass, b_pass, pass_verdict, discriminating, checks FROM contrasts',
    )
    assert.deepEqual(
      rows.map((r) => [
        r.a_environment,
        r.b_environment,
        r.a_pass,
        r.b_pass,
        r.pass_verdict,
        r.discriminating,
        r.checks,
      ]),
      [
        ['current-skill', 'no-skill', 0, 0, 'insufficient', 'Social OAuth', 5],
        ['new-skill', 'no-skill', 0, 0, 'insufficient', null, 5],
        ['new-skill', 'current-skill', 0, 0, 'insufficient', 'Social OAuth', 5],
      ],
    )
    const { digest } = await digestOf(p.dir, ['--vs', 'none'])
    const contrasts = digest.facts.filter((f) => f.kind === 'contrast')
    assert.deepEqual(
      contrasts.map((f) => [
        f.a,
        f.b,
        f.passRate,
        f.liftVerdict,
        (f.checks as Row[]).map((k) => k.label),
      ]),
      [
        ['current-skill', 'no-skill (control)', '0/3 vs 0/3', 'insufficient', ['Social OAuth']],
        ['new-skill', 'no-skill (control)', '0/3 vs 0/3', 'insufficient', []],
        ['new-skill', 'current-skill', '0/3 vs 0/3', 'insufficient', ['Social OAuth']],
      ],
    )
    assert.equal(
      digest.facts.filter((f) => f.kind === 'checks').length,
      0,
      'contrast facts replace the per-variant checks facts',
    )
  })

  test('canary: with one variant there is no variant-against-variant row', async () => {
    const p = await project('study-one-variant', studyFiles({ gate: 'none', oneVariant: true }))
    const run = await runCli(p.dir)
    assert.equal(run.code, 0, run.stdout + run.stderr)
    assert.doesNotMatch(run.stdout, /contrasts \(each pair/)
    assert.doesNotMatch((await runCli(p.dir, ['show'])).stdout, /vs current-skill/)
    assert.deepEqual(await query(p.dir, 'SELECT * FROM contrasts'), [])
    const { digest } = await digestOf(p.dir, ['--vs', 'none'])
    assert.equal(digest.facts.filter((f) => f.kind === 'contrast').length, 0)
    assert.equal(digest.facts.filter((f) => f.kind === 'checks').length, 1)
  })
})
