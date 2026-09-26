// The analysis MVP (docs/analysis-feature-design.md): the facts views in `es query`, effort next to
// lift, and `es analyze`. The facts come out exactly on two real dogfood histories (trimmed by
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
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { COMMANDS, checkCommand, FLAGS } from '../src/cli-spec.ts'
import { mannWhitney, minimumP } from '../src/stats.ts'
import { createStudioApp } from '../src/studio/server.ts'
import { analysisDataPath } from '../src/view/analysis.ts'
import { contrastEffort, effortLabel } from '../src/view/effort.ts'
import { fakeConfig, pkgRoot, project, readRun, runCli } from './helpers.ts'

type Row = Record<string, unknown>
const FIXTURES = join(pkgRoot, 'test/fixtures/analysis')
const UPDATE = !!process.env.ES_UPDATE_SNAPSHOTS

const CONFIG = `import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'
export default defineConfig({
  harness: fakeHarness({}),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
  ANALYSIS
})
`

/** A project whose history is a copy of a fixture history, with an optional `analysis` config. */
async function historyProject(name: string, fixture: string, analysis = '') {
  const p = await project(name, { 'es.config.ts': CONFIG.replace('ANALYSIS', analysis) })
  cpSync(join(FIXTURES, fixture), join(p.dir, 'evals/.history'), { recursive: true })
  return p
}

async function query(dir: string, sql: string): Promise<Row[]> {
  const r = await runCli(dir, ['query', sql, '--json'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  return JSON.parse(r.stdout) as Row[]
}

/** The digest `es analyze --context` hands over, parsed back out of its Markdown. */
async function digestOf(dir: string, args: string[] = []) {
  const r = await runCli(dir, ['analyze', '--context', ...args])
  assert.equal(r.code, 0, r.stderr)
  const json = /```json\n([\s\S]*?)\n```/.exec(r.stdout)?.[1]
  assert.ok(json, 'the context holds the digest')
  return { text: r.stdout, digest: JSON.parse(json) as Digest }
}

type Digest = {
  facts: Array<Row & { id: string; kind: string }>
  evidence: Array<{ id: string; ref: string; lines: string[] }>
  attempts: Record<string, Row>
}

/** Compares `value` with a golden file; ES_UPDATE_SNAPSHOTS=1 rewrites it. */
function golden(name: string, value: unknown) {
  const path = join(FIXTURES, `${name}.golden.json`)
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (UPDATE || !existsSync(path)) writeFileSync(path, text)
  assert.equal(text, readFileSync(path, 'utf8'), `${name} differs from ${relative(pkgRoot, path)}`)
}

const FACT_QUERIES = {
  effort:
    'SELECT run_id, eval_key, cell_key, n, tools_median, agent_s_median, tools_ratio, tools_p, separated, verdict, time_verdict FROM effort ORDER BY run_id, eval_key, cell_key',
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

  test('flaky: one failure in 4 comparable attempts is insufficient, not flaky (the old view said flaky)', async () => {
    const p = await historyProject('facts-flaky', 'dogfood')
    const old = await query(p.dir, 'SELECT eval_key, key FROM cells WHERE pass > 0 AND fail > 0')
    assert.equal(old.length, 1, 'the old flaky_cells rule flags the fix-config control')
    const flaky = await query(p.dir, 'SELECT * FROM flaky_cells')
    assert.deepEqual(
      flaky.map((f) => [f.cell_key, f.runs, f.pass, f.counted, f.verdict, f.cause]),
      [['cursor:composer-2.5/broken-project/es-tarball', 2, 3, 4, 'insufficient', 'agent']],
      'pooled over both runs, which are comparable once runtime state is left out; a 0.10 verdict is the agent, not the judge',
    )
    assert.deepEqual([flaky[0]?.lo, flaky[0]?.hi], [0.301, 0.954])
  })

  test('drift: only Cursor runtime state changed, so it is noise (the old view blamed context)', async () => {
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
  test('harness contrasts are controlled within a run; a clean sweep is an effect, the rest is noise', async () => {
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
      ['antigravity:gemini-3.8-flash-low', 'cursor:composer-2.5', 0, 2, 'effect'],
      'antigravity failed both control attempts that cursor passed: the interval excludes 0',
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

  test('mixed outcomes over enough comparable attempts are flaky, caused by the agent', async () => {
    const p = await project('canary-flaky', {
      'es.config.ts': fakeConfig(),
      'evals/f.es.ts': `import { evaluate } from 'evalsuite'
evaluate('flips', { runs: 6, gate: { passRate: 0.5 } }, async (t) => {
  await t.send('go')
  if (t.attempt.n % 2 === 0) throw new Error('every other attempt fails')
})
`,
    })
    assert.equal((await runCli(p.dir)).code, 0)
    const [flaky] = await query(p.dir, 'SELECT pass, counted, verdict, cause FROM flaky_cells')
    assert.deepEqual(flaky, { pass: 3, counted: 6, verdict: 'flaky', cause: 'agent' })
  })
})

describe('effort next to lift', () => {
  test('the rank test is exact: 4 against 4, fully separated, is 2/70', () => {
    assert.equal(mannWhitney([4, 5, 5, 6], [30, 40, 50, 60]), 2 / 70)
    assert.equal(mannWhitney([1, 2], [3, 4]), 1 / 3)
    assert.equal(minimumP(2, 2), 1 / 3)
    const c = contrastEffort(
      [4, 5, 5, 6].map((tools) => ({ tools, agentMs: 20_000, fileEdits: 1 })),
      [30, 40, 50, 60].map((tools) => ({ tools, agentMs: 45_000, fileEdits: 1 })),
    )
    assert.ok(c)
    assert.equal(
      effortLabel(c),
      'tools 5 vs 45 (×0.11), agent 20s vs 45s (×0.44): fewer tool calls (p = 0.029)',
    )
  })

  test('es run, summary.md and es compare show each variant cell\u2019s effort beside its lift', async () => {
    const p = await project('effort-summary', {
      'es.config.ts': fakeConfig({ harness: "{ withSkill: { files: { 'ok.txt': 'y' } } }" }),
      'skills/s/SKILL.md': '---\nname: s\ndescription: A skill. Use when testing.\n---\nBody.\n',
      'evals/c.es.ts': `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const skilled = defineEnvironment('skilled', ({ skill }) => ({ skills: [skill.local('../skills/s')] }))
evaluate('greets', { compare: [skilled], runs: 2 }, async (t) => {
  await t.send('go')
  await expect(t).toHaveFile('ok.txt')
})
`,
    })
    const first = await runCli(p.dir)
    assert.equal(first.code, 0, first.stdout)
    assert.match(
      first.stdout,
      /skilled.*lift \+100 pts[^\n]*\n\s+effort: tools \d+ vs \d+ \(×[\d.–]+\), agent \d+s vs \d+s \(×[\d.–]+\): too few attempts to test/,
    )
    const { read } = readRun(p.dir)
    assert.match(read('summary.md'), /effort tools \d+ vs \d+/)
    assert.equal((await runCli(p.dir)).code, 0)
    const compare = await runCli(p.dir, ['compare', 'latest~1', 'latest'])
    assert.equal(compare.code, 0, compare.stderr)
    assert.match(
      compare.stdout,
      /\n {6}fake\/skilled\/fake {2}lift \+100 \(\+\d+…\+100\)( noise)? → \+100[^\n]* · tools \d+ → \d+/,
    )
    const json = JSON.parse(
      (await runCli(p.dir, ['compare', 'latest~1', 'latest', '--json'])).stdout,
    )
    const skilled = json.rows[0].perCell.find((c: { key: string }) => c.key === 'fake/skilled/fake')
    assert.deepEqual([skilled.head.effort.n, skilled.head.lift.points], [2, 1])
  })
})

describe('es CLI spec', () => {
  test('verify commands must parse as ES commands with their own flags', () => {
    const tables = ['effort', 'lift']
    const ok = [
      'es query effort',
      'npx es run --record',
      'pnpm es compare latest~1 latest --md',
      'es analyze latest --vs latest~1 --json',
      'es run --tag smoke -vv',
      'es studio build --out site',
      'es image build --dry-run',
      `es query "SELECT * FROM effort WHERE verdict = 'fewer'"`,
      'es run --record && es query effort',
    ]
    for (const c of ok) assert.equal(checkCommand(c, tables), null, c)
    const bad: Array<[string, RegExp]> = [
      ['npx es compare r1 r2 --include-efficiency', /--include-efficiency isn't an ES flag/],
      ['es eval fix-config --debug-judge', /es eval isn't an ES command/],
      ['es run --eval scaffold', /--eval isn't an option of es run/],
      ['es query efficiency', /no view or table named efficiency/],
      ['es show latest --md --json extra', /takes at most 1 argument/],
      ['es run --runs', /--runs needs a value/],
      ['cat evals/x.ts', /isn't an es command/],
      ['es query effort | head', /pipes/],
    ]
    for (const [c, why] of bad) assert.match(checkCommand(c, tables) ?? '', why, c)
  })

  test('the spec and es --help name the same commands and flags', async () => {
    const p = await project('cli-spec', { 'es.config.ts': fakeConfig() })
    const help = (await runCli(p.dir, ['--help'])).stdout
    for (const command of Object.keys(COMMANDS))
      assert.match(help, new RegExp(`\\n  es ${command}\\b`), command)
    const named = new Set([...help.matchAll(/--([a-z][a-z-]+)/g)].map((m) => m[1] as string))
    for (const flag of named) assert.ok(flag in FLAGS, `--${flag} in es --help isn't in the spec`)
    for (const flag of Object.keys(FLAGS))
      assert.ok(named.has(flag), `--${flag} isn't in es --help`)
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
          anomalies: [{ text: 'Saturated evals.', kind: 'eval-design', cites: [sat.id] }],
          actions: [
            action('npx es compare r1 r2 --include-efficiency'),
            action('es query efficiency'),
            action('es eval fix-config --debug-judge'),
            action('es query effort'),
            action('es run --record', ['F999']),
          ],
          confidence: { overall: 'medium', why: 'n = 4 per cell per eval' },
        }
      },
    }),
  },`
const FAKE_IMPORTS =
  "import { appendFileSync } from 'node:fs'\nimport { fakeAnalysis } from 'evalsuite/judge'\n"

async function fakeProject(name: string) {
  const p = await historyProject(name, 'dogfood', FAKE)
  const config = join(p.dir, 'es.config.ts')
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
      out.set(name, createHash('sha256').update(readFileSync(path)).digest('hex'))
  }
  return out
}

const HEAD = '20260926T104633Z_041aef3_ci_jzvq'
const BASE = '20260926T104130Z_60f3dc9_cursor-agent_92gs'

describe('es analyze', () => {
  test('the digest is facts with ids, evidence by rule, and the verdict rules; --context needs no key', async () => {
    const p = await historyProject('analyze-context', 'dogfood')
    const { text, digest } = await digestOf(p.dir)
    assert.match(text, new RegExp(`# ES analysis context: ${HEAD} vs ${BASE}`))
    assert.match(text, /es query factor_effects/)
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
      a.actions.map((x: { verify: string | null }) => x.verify),
      [null, null, null, 'es query effort'],
      'the action citing only F999 is dropped',
    )
    assert.match(a.actions[0].verifyProblem, /--include-efficiency isn't an ES flag/)
    const v = doc.validation
    assert.deepEqual([v.dropped, v.commands, v.invalidCommands.length], [4, 4, 3])
    assert.deepEqual(
      v.invalid.filter((x: string) => !x.includes('quote') && !x.includes("isn't in the cited")),
      ['whatHappened[1]: r9/nope/control#1', 'whatHappened[2]: E1:L9999', 'actions[4]: F999'],
    )
    assert.match(doc.cited['r2/fix-config/control#1'], /fail/)
    assert.deepEqual(doc.attempts['r2/fix-config/control#1'], {
      runId: HEAD,
      evalSlug: 'evals-fix-config-es-ts-broken-project-fixes-a-broken-config-854800',
      attempt: 'cursor:composer-2.5/broken-project/es-tarball#1',
    })
    const text = await runCli(p.dir, ['analyze'])
    assert.match(
      text.stdout,
      /verify: none \(npx es compare r1 r2 --include-efficiency: --include-efficiency isn't an ES flag\)/,
    )
    assert.match(
      text.stdout,
      /14 citations checked, 4 invalid, 4 dropped · 4 commands checked, 3 rejected/,
    )
  })

  test('a cached analysis makes no call; --no-cache does', async () => {
    const p = await fakeProject('analyze-cache')
    assert.equal((await runCli(p.dir, ['analyze'])).code, 0)
    assert.equal(calls(p.dir), 1)
    const again = await runCli(p.dir, ['analyze', '--md'])
    assert.equal(again.code, 0, again.stderr)
    assert.equal(calls(p.dir), 1, 'the cache answered')
    assert.match(again.stderr, /cached analysis from/)
    assert.match(again.stdout, /^## ES analysis · /)
    assert.equal(readdirSync(join(p.dir, '.es/analysis')).length, 1)
    const dry = await runCli(p.dir, ['analyze', '--dry-run'])
    assert.match(dry.stdout, /cache hit/)
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
    assert.equal(readdirSync(join(p.dir, '.es/analysis')).length, 1, 'the cache has it too')

    const twice = await runCli(p.dir, ['analyze', '--save'])
    assert.equal(twice.code, 2)
    assert.match(twice.stderr, /is already saved for .+\. Saved analyses are never rewritten\./)
    assert.deepEqual([...tree(history).keys()].sort(), [...after.keys()].sort())

    // The studio shows saved and cached analyses live, and saved ones in a static build.
    const app = createStudioApp({
      source: { root: p.dir, historyDir: history, scratch: false },
      appDir: join(pkgRoot, 'dist/studio-app'),
      es: 'test',
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
        /es analyze needs a language model\. Set analysis: \{ model: 'google\/gemini-3\.8-flash' \}.*es analyze --context/,
      ],
      [
        "analysis: { model: 'typesafe-ai/jev-1.13.0' },",
        /is an evaluation model: it scores yes\/no questions/,
      ],
      [
        "analysis: { model: 'google/gemini-3.8-flash' },",
        /No credentials for analysis model "google\/gemini-3\.8-flash"\. Set GOOGLE_GENERATIVE_AI_API_KEY.*--context, which needs no key/,
      ],
      [
        "analysis: { model: 'gemini' },",
        /config\.analysis\.model "gemini" needs a provider prefix/,
      ],
      [
        'analysis: { maxInputTokens: 10 },',
        /maxInputTokens must be a whole number of at least 1000/,
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
    mkdirSync(join(p.dir, '.es/runs'), { recursive: true })
    writeFileSync(
      join(p.dir, '.es/runs', `${later}.json`),
      JSON.stringify({ ...record, runId: later }),
    )
    const r = await runCli(p.dir, ['analyze', 'latest', '--save'])
    assert.equal(r.code, 2)
    assert.match(
      r.stderr,
      /isn't recorded, so there's no history folder to save into\. Run es record/,
    )
  })
})
