// The analysis pipeline: the facts views in `reeval query`, effort next to
// lift, and `reeval analyze`. The facts come out exactly on two real dogfood histories (trimmed by
// fixtures/analysis/trim.mjs), each verdict rule has a canary where the opposite data must flip it,
// and the model step runs on a fake model that returns canned (and deliberately wrong) answers.
// `analysis.agent`'s notes run on a fake model that calls the real tools through the AI SDK's loop,
// over real harness transcripts and diffs from the record corpus (test/support/real-runs.ts).
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
import type { ShapeSchema } from '../scripts/schema/generate.ts'
import { validate } from '../scripts/schema/validate.ts'
import { noteTools, writeAgentNote } from '../src/analysis/agent/note.ts'
import { investigate, summaryTools, toolReads } from '../src/analysis/agent/summary.ts'
import {
  type AttemptView,
  attemptSummary,
  divergence,
  fromRecorded,
  listOutcomes,
  stagedAttempts,
} from '../src/analysis/agent/tools.ts'
import { analyseDigest, defaultBase, prepareAnalysis } from '../src/analysis/command.ts'
import { type Digest as AnalysisDigest, RULES } from '../src/analysis/digest.ts'
import { listAnalyses, listNotes, noteFileName } from '../src/analysis/files.ts'
import { resolveAnalysisModel } from '../src/analysis/model.ts'
import { analysisSchema, SYSTEM_PROMPT } from '../src/analysis/schema.ts'
import {
  capConfidence,
  rewriteGuessedTagCommand,
  validateAnalysis,
} from '../src/analysis/validate.ts'
import { COMMANDS, checkCommand, FLAGS } from '../src/cli-spec.ts'
import { allRuns } from '../src/commands.ts'
import { resolveConfig } from '../src/config.ts'
import { LIFT_MIN_COUNTED } from '../src/history/facts.ts'
import type { HistoryEntry } from '../src/history/types.ts'
import { recordFileName } from '../src/ids.ts'
import { fakeAnalysis } from '../src/judge.ts'
import { mannWhitney, minimumP } from '../src/stats.ts'
import { createStudioApp } from '../src/studio/server.ts'
import type { EvalResult } from '../src/ui/events.ts'
import { type AnalysisNote, analysisDataPath, pinnedAnalysis } from '../src/view/analysis.ts'
import { contrastEffort, effortLabel } from '../src/view/effort.ts'
import { parseTranscript } from '../src/view/model.ts'
import { NewerSchemaError, readableAnalysis, readableAnalysisNote } from '../src/view/record.ts'
import { fakeConfig, pkgRoot, project, readRun, runCli, tempDir } from './helpers.ts'
import { REAL_HARNESSES, type RealAttempt, realAttempts } from './support/real-runs.ts'

type Row = Record<string, unknown>
const FIXTURES = join(pkgRoot, 'test/fixtures/analysis')
const UPDATE = !!process.env.REEVAL_UPDATE_SNAPSHOTS

const CONFIG = `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: fakeHarness({}),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
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
  facts: Array<Row & { id: string; kind: string }>
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

  test('reeval run, summary.md and reeval compare show each variant cell\u2019s effort beside its lift', async () => {
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
    assert.match(
      first.stdout,
      /skilled.*lift \+100 pts[^\n]*\n\s+effort: tools \d+ vs \d+ \(×[\d.–]+\), agent [\d.]+s vs [\d.]+s \(×[\d.–]+\): too few attempts to test/,
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

describe('reeval CLI spec', () => {
  test('verify commands must parse as reeval commands with their own flags', () => {
    const tables = ['effort', 'lift']
    const ok = [
      'reeval query effort',
      'npx reeval run --record',
      'pnpm reeval compare latest~1 latest --md',
      'reeval analyze latest --vs latest~1 --json',
      'reeval run --tag smoke -vv',
      'reeval studio build --out site',
      'reeval image build --dry-run',
      `reeval query "SELECT * FROM effort WHERE verdict = 'fewer'"`,
      'reeval run --record && reeval query effort',
    ]
    for (const c of ok) assert.equal(checkCommand(c, tables), null, c)
    const bad: Array<[string, RegExp]> = [
      ['npx reeval compare r1 r2 --include-efficiency', /--include-efficiency isn't a reeval flag/],
      ['reeval eval fix-config --debug-judge', /reeval eval isn't a reeval command/],
      ['reeval run --eval scaffold', /--eval isn't an option of reeval run/],
      ['reeval query efficiency', /no view or table named efficiency/],
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
          anomalies: [{ text: 'Saturated evals.', kind: 'eval-design', cites: [sat.id] }],
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
    assert.match(RULES[0] ?? '', new RegExp(`fewer than ${LIFT_MIN_COUNTED} counted attempts`))
  })

  test('the prompt and rules say a changed eval is not an effect', () => {
    assert.match(SYSTEM_PROMPT, /first line says the eval changed/)
    assert.match(SYSTEM_PROMPT, /A lift is an effect only when sources match/)
    assert.match(SYSTEM_PROMPT, /mixed counts such as 6\/10 vs 8\/9 are not a results line/)
    assert.match(RULES[1] ?? '', /not comparable: the eval changed/)
    assert.match(RULES[1] ?? '', /Do not put those mixed counts on a results line/)
  })

  test('the prompt asks for one sentence and does not self-rate checks', () => {
    assert.match(SYSTEM_PROMPT, /one sentence: what happened, how sure, why, next/)
    assert.match(SYSTEM_PROMPT, /Do not rate your own citation or command checks/)
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

  test('a rejected verify is dropped, or rewritten from --tag to the eval id', () => {
    const evals = [
      {
        file: 'evals/sign-in.eval.ts',
        name: 'sign-in',
        id: 'evals/sign-in.eval.ts › sign-in',
        tags: [] as string[],
        cells: ['fake/-'],
      },
    ]
    assert.equal(
      rewriteGuessedTagCommand('reeval run --tag sign-in', evals),
      "reeval run 'evals/sign-in.eval.ts › sign-in'",
    )
    assert.equal(
      rewriteGuessedTagCommand('reeval run --runs 6 --tag=sign-in', evals),
      "reeval run --runs 6 'evals/sign-in.eval.ts › sign-in'",
    )
    assert.equal(rewriteGuessedTagCommand('reeval run --tag nosuch', evals), null)
    assert.equal(rewriteGuessedTagCommand('reeval run --tag auth', evals), null)
    assert.equal(
      rewriteGuessedTagCommand('reeval run --tag skill', [{ ...evals[0], tags: ['skill'] }]),
      null,
      'a real tag is left alone',
    )

    const digest: AnalysisDigest = {
      digestVersion: 5,
      scope: { kind: 'run', head: 'r1', base: null, evals: null },
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
      facts: [{ id: 'F1', kind: 'pass-rate' }],
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
    const rewritten = validateAnalysis(
      { ...base, actions: [action('reeval run --tag sign-in')] },
      digest,
      [],
      evals,
    )
    assert.deepEqual(
      rewritten.body.actions.map((a) => a.verify),
      ["reeval run 'evals/sign-in.eval.ts › sign-in'"],
    )
    assert.equal(rewritten.validation.invalidCommands.length, 0)
    assert.equal(rewritten.validation.dropped, 0)
    assert.equal(rewritten.body.confidence.overall, 'high')

    const dropped = validateAnalysis(
      { ...base, actions: [action('reeval run --tag nosuch'), action('reeval query nope')] },
      digest,
      [],
      evals,
    )
    assert.deepEqual(dropped.body.actions, [])
    assert.equal(dropped.validation.dropped, 2)
    assert.equal(dropped.validation.invalidCommands.length, 2)
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

  test('one counted attempt a side is insufficient lift, not a results verdict', async () => {
    const p = await compareProject('analyze-sparse-lift', 1)
    const run = await runCli(p.dir)
    assert.equal(run.code, 0, run.stdout)
    assert.match(
      run.stdout,
      /lift \+100 pts \(95% −12…\+100, 1\/1 vs 0\/1\), within noise/,
      'the run summary still prints the interval',
    )
    const { digest } = await digestOf(p.dir)
    const pass = digest.facts.find((f) => f.kind === 'pass-rate')
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

  test('two counted attempts can still be an effect', async () => {
    const p = await compareProject('analyze-lift-effect', 2)
    assert.equal((await runCli(p.dir)).code, 0)
    const { digest } = await digestOf(p.dir)
    const pass = digest.facts.find((f) => f.kind === 'pass-rate')
    const variant = (pass?.cells as Array<{ lift?: string; verdict?: string }> | undefined)?.find(
      (c) => c.lift,
    )
    assert.match(variant?.lift ?? '', /^\+100 pts \(95% \+7…\+100\)$/)
    assert.equal(variant?.verdict, 'effect')
    const [row] = await query(
      p.dir,
      "SELECT pass_verdict FROM factor_effects WHERE tier = 'controlled'",
    )
    assert.equal(row?.pass_verdict, 'effect')
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
      ['reeval query effort'],
      'rejected verifies are dropped; the action citing only F999 is dropped',
    )
    assert.equal(a.actions[0].verifyProblem, undefined)
    const v = doc.validation
    assert.deepEqual([v.dropped, v.commands, v.invalidCommands.length], [7, 4, 3])
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
    assert.doesNotMatch(text.stdout, /verify: none/)
    assert.match(text.stdout, /verify: reeval query effort/)
    assert.match(
      text.stdout,
      /14 citations checked, 4 invalid, 7 dropped · 4 commands checked, 3 rejected/,
    )
    assert.equal(a.confidence.overall, 'low', 'dropped claims and rejected commands cap to low')
    assert.match(text.stdout, /^TL;DR \(low\) {2}/m)
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
        /reeval analyze needs a language model\. Set analysis: \{ model: 'google\/gemini-3\.8-flash' \}.*reeval analyze --context/,
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
      [
        'analysis: { maxOutputTokens: 10 },',
        /maxOutputTokens must be a whole number of at least 500/,
      ],
      ['analysis: { maxCostUsd: 0.25 },', /Unknown option "maxCostUsd" in config\.analysis/],
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

/** One staged worker record, with each turn's steps as tool calls, and its engine result. */
function staged(
  dir: string,
  cell: string,
  n: number,
  outcome: 'pass' | 'fail',
  shells: string[],
  more: { exit?: number; files?: string[]; verdict?: 'pass' | 'fail' } = {},
): EvalResult {
  const id = 'evals/s.eval.ts › writes'
  const key = `${id} # ${cell}#${n}`
  const record = {
    outcome,
    error: outcome === 'fail' ? { kind: 'assertion', message: 'expected ok.txt' } : null,
    turns: [
      {
        prompt: 'Write ok.txt',
        text: outcome === 'pass' ? 'Wrote ok.txt.' : 'Could not write it.',
        status: 'completed',
        transcript: shells.map((command, i) => ({
          type: 'tool',
          toolCallId: `c${i}`,
          tool: 'shell',
          input: { command },
          output: '',
          ok: true,
          durationMs: 1,
        })),
      },
    ],
    diff: { patch: '', files: (more.files ?? []).map((path) => ({ path, status: 'added' })) },
    checks: [
      {
        command: 'test -f ok.txt',
        exitCode: more.exit ?? 0,
        stdout: '',
        stderr: more.exit ? 'no ok.txt' : '',
      },
    ],
    judgements: more.verdict
      ? [
          {
            question: 'Is it tidy?',
            verdict: more.verdict,
            score: more.verdict === 'pass' ? 0.9 : 0.2,
            threshold: 0.5,
            model: 'fake',
          },
        ]
      : [],
  }
  mkdirSync(join(dir, 'evals'), { recursive: true })
  writeFileSync(join(dir, 'evals', recordFileName(key)), JSON.stringify(record))
  const [harness = '', environment = ''] = cell.split('/')
  return {
    id,
    key,
    file: 'evals/s.eval.ts',
    group: [],
    name: 'writes',
    attempt: { cell: { key: cell, harness, environment }, n } as EvalResult['attempt'],
    state: outcome === 'pass' ? 'passed' : 'failed',
    durationMs: 1,
    errors: outcome === 'fail' ? ['expected ok.txt'] : [],
    formattedErrors: [],
    meta: undefined,
  }
}

const realRunDir = (r: RealAttempt) =>
  join(pkgRoot, 'test/fixtures/records', r.entry, 'evals/.history', r.runId)

/** A real recorded attempt as its worker staged it: turns from transcript.jsonl, and diff.patch. */
function stageReal(dir: string, r: RealAttempt, as: { cell: string; n: number }): EvalResult {
  const lines = parseTranscript(r.transcript ? readFileSync(r.transcript, 'utf8') : '')
  const run = realRunDir(r)
  const record = {
    outcome: r.attempt.outcome,
    error: r.attempt.error,
    turns: r.attempt.turns.map((t, i) => ({
      ...t,
      transcript: lines.filter((l) => l.turn === i && l.type !== 'prompt' && l.type !== 'turn-end'),
    })),
    diff: r.diff ? { patch: readFileSync(r.diff, 'utf8'), files: r.attempt.changedFiles } : null,
    checks: r.attempt.checks.map((c) => ({
      command: c.command,
      exitCode: c.exitCode,
      durationMs: c.durationMs,
      stdout: c.log ? readFileSync(join(run, c.log.path), 'utf8') : '',
      stderr: '',
    })),
    judgements: r.attempt.judgements,
  }
  const key = `${r.eval.id} # ${as.cell}#${as.n}`
  mkdirSync(join(dir, 'evals'), { recursive: true })
  writeFileSync(join(dir, 'evals', recordFileName(key)), JSON.stringify(record))
  const cell = r.eval.cells.find((c) => c.key === r.attempt.cell)
  return {
    id: r.eval.id,
    key,
    file: r.eval.file,
    group: r.eval.group,
    name: r.eval.name,
    attempt: { cell: { ...cell, key: as.cell }, n: as.n } as EvalResult['attempt'],
    state: r.attempt.outcome === 'pass' ? 'passed' : 'failed',
    durationMs: r.attempt.durationMs,
    errors: r.attempt.error ? [r.attempt.error.message] : [],
    formattedErrors: [],
    meta: undefined,
  }
}

/**
 * One real harness's contract run as a note's attempts: each eval is a cell, and its canary (which
 * fails before the agent runs) that cell's second run.
 */
async function contractGroup(harness: string): Promise<AttemptView[]> {
  const rows = realAttempts('real-contract').filter((r) => r.harness === harness)
  return Promise.all(
    rows.map(async (r) => {
      const cell = `${harness}/${r.eval.name.replace(/ canary$/, '')}`
      const n = r.eval.name.endsWith(' canary') ? 2 : 1
      return { ...(await fromRecorded(realRunDir(r), r.attempt)), id: `${cell}#${n}`, cell, n }
    }),
  )
}

const AGENT_CONFIG = (analysis: string) => `import { appendFileSync } from 'node:fs'
import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
const called = () => appendFileSync(new URL('./calls.log', import.meta.url), 'call\\n')
export default defineConfig({
  harness: [fakeHarness({ id: 'steady', files: { 'ok.txt': 'yes' } }), fakeHarness({ id: 'wobbly', files: { 'ok.txt': 'yes' } })],
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  ${analysis}
})
`

const AGENT_EVALS = {
  'evals/w.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('writes ok.txt', { runs: 3 }, async (c) => {
  await c.send('Write ok.txt')
  const wobble = c.attempt.cell.harness === 'wobbly' && c.attempt.n === 2
  await expect(c).toHaveFile(wobble ? 'missing.txt' : 'ok.txt')
})
evaluate('reads ok.txt', async (c) => {
  await c.send('Read ok.txt')
  await expect(c).toHaveFile('ok.txt')
})
`,
}

const notesOf = (dir: string) => {
  const runs = join(dir, '.reeval/analysis')
  const [runId] = readdirSync(runs).filter((n) => !n.endsWith('.json'))
  const folder = join(runs, runId as string, 'notes')
  return {
    runId: runId as string,
    names: readdirSync(folder).sort(),
    notes: readdirSync(folder)
      .sort()
      .map((n) => JSON.parse(readFileSync(join(folder, n), 'utf8')) as AnalysisNote),
  }
}

describe('analysis.agent: a note per eval and harness during reeval run', () => {
  test('on made-up staged records, missing and cut-short ones too, the tools pair failures and find where steps diverge', async () => {
    const dir = join(tempDir('notes-staging'), 'staging')
    const results = [
      staged(dir, 'fake/fake/fake', 1, 'pass', ['ls', 'cat SKILL.md', 'touch ok.txt'], {
        files: ['ok.txt'],
        verdict: 'pass',
      }),
      staged(dir, 'fake/fake/fake', 2, 'fail', ['ls', 'cat SKILL.md', 'touch ok.tx'], {
        exit: 1,
        files: ['ok.tx'],
        verdict: 'fail',
      }),
      staged(dir, 'fake/fake/fake', 3, 'pass', ['ls', 'cat SKILL.md', 'touch ok.txt'], {
        files: ['ok.txt'],
      }),
      staged(dir, 'fake/skilled/fake', 1, 'fail', ['ls'], { exit: 1 }),
    ]
    // Attempts whose record is missing (a worker died) or cut short: the engine's result is all there is.
    const lost = { ...staged(dir, 'fake/skilled/fake', 2, 'fail', []), key: 'no record' }
    const cut = staged(dir, 'fake/skilled/fake', 3, 'fail', [])
    writeFileSync(join(dir, 'evals', recordFileName(cut.key)), '{"outcome": "fa')
    const attempts = await stagedAttempts(dir, [...results, lost, cut])
    assert.deepEqual(
      attempts.map((a) => [a.id, a.outcome, a.error?.kind ?? null]),
      [
        ['fake/fake/fake#1', 'pass', null],
        ['fake/fake/fake#2', 'fail', 'assertion'],
        ['fake/fake/fake#3', 'pass', null],
        ['fake/skilled/fake#1', 'fail', 'assertion'],
        ['fake/skilled/fake#2', 'fail', 'assertion'],
        ['fake/skilled/fake#3', 'fail', 'assertion'],
      ],
    )
    const listed = listOutcomes(attempts)
    assert.deepEqual(listed.pairs, [
      { failed: 'fake/fake/fake#2', passed: 'fake/fake/fake#1', match: 'cell' },
      { failed: 'fake/skilled/fake#1', passed: 'fake/fake/fake#1', match: 'harness' },
      { failed: 'fake/skilled/fake#2', passed: 'fake/fake/fake#1', match: 'harness' },
      { failed: 'fake/skilled/fake#3', passed: 'fake/fake/fake#3', match: 'harness' },
    ])
    assert.deepEqual(listed.attempts[1]?.failedChecks, ['test -f ok.txt'])
    assert.equal(listed.attempts[0]?.steps, 3)

    const d = divergence(attempts[1] as AttemptView, attempts[0] as AttemptView)
    assert.equal(d.stepsInCommon, 2)
    assert.equal(d.divergedAt, 3, 'the third step differs')
    assert.deepEqual(d.failedSteps, ['shell: ls', 'shell: cat SKILL.md', 'shell: touch ok.tx'])
    assert.deepEqual(d.passedSteps, ['shell: ls', 'shell: cat SKILL.md', 'shell: touch ok.txt'])
    assert.deepEqual(d.checks, [
      { command: 'test -f ok.txt', failed: 1, passed: 0, failedOutput: 'no ok.txt' },
    ])
    assert.deepEqual(d.judgements, [{ question: 'Is it tidy?', failed: 'fail', passed: 'pass' }])
    assert.deepEqual(d.files, { onlyFailed: ['ok.tx'], onlyPassed: ['ok.txt'] })
    assert.equal(
      divergence(attempts[2] as AttemptView, attempts[0] as AttemptView).divergedAt,
      null,
      'the same steps never diverge',
    )

    const tools = noteTools(attempts, JSON.stringify(listed).length + 10)
    const call = (name: keyof typeof tools, input: object) =>
      (tools[name].execute as (i: object, o: object) => Promise<unknown>)(input, {
        toolCallId: 't',
        messages: [],
      })
    assert.deepEqual(
      await call('compare_attempts', { failed: 'nope#1', passed: 'fake/fake/fake#1' }),
      {
        error: `No attempt nope#1. The attempts are ${attempts.map((a) => a.id).join(', ')}.`,
      },
    )
    assert.ok(!('error' in ((await call('list_attempts', {})) as object)))
    assert.match(
      String(
        ((await call('open_attempt', { id: 'fake/fake/fake#1' })) as { error?: string }).error,
      ),
      /The input budget \(analysis\.maxInputTokens\) is spent/,
      'the tools stop at the input budget',
    )
  })

  test('real harness transcripts and diffs read the same from a staged record and a recorded run', async () => {
    const dir = join(tempDir('notes-real-staging'), 'staging')
    const reached = realAttempts().filter((r) => r.transcript)
    assert.deepEqual([...new Set(reached.map((r) => r.harness))].sort(), [...REAL_HARNESSES].sort())
    for (const r of reached) {
      const recorded = await fromRecorded(realRunDir(r), r.attempt)
      const [staged] = await stagedAttempts(dir, [
        stageReal(dir, r, { cell: r.attempt.cell, n: r.attempt.n }),
      ])
      const what = `${r.entry} ${r.harness} ${r.eval.name}`
      assert.deepEqual(staged, recorded, what)
      assert.deepEqual(
        recorded.files,
        r.attempt.changedFiles.map((f) => f.path),
        what,
      )
      assert.equal(recorded.patch, r.diff ? readFileSync(r.diff, 'utf8') : '', what)
    }
    for (const harness of REAL_HARNESSES) {
      const steps = await Promise.all(
        reached
          .filter((r) => r.harness === harness)
          .map(async (r) =>
            (await fromRecorded(realRunDir(r), r.attempt)).turns.flatMap((t) => t.steps),
          ),
      )
      assert.ok(
        steps.filter((s) => s.length > 0).length >= 6,
        `${harness}: most attempts used tools`,
      )
    }
    const edits = reached.filter(
      (r) => r.entry === 'real-contract' && r.eval.name === 'edit and run',
    )
    for (const r of edits) {
      const view = await fromRecorded(realRunDir(r), r.attempt)
      const steps = view.turns.flatMap((t) => t.steps)
      assert.ok(steps.includes('edit (modify): notes.txt'), `${r.harness}: ${steps.join(' | ')}`)
      assert.ok(
        steps.some((s) => s.includes('echo contract-$((6*7))')),
        r.harness,
      )
      assert.match(attemptSummary(view).diff, /^\+\+\+ b\/notes\.txt$/m, r.harness)
    }
  })

  test('on real traces, a failed canary pairs with its passing eval and diverges at its first step', async () => {
    for (const harness of REAL_HARNESSES) {
      const attempts = await contractGroup(harness)
      const listed = listOutcomes(attempts)
      assert.equal(listed.attempts.length, 12, harness)
      assert.deepEqual(
        listed.pairs.map((p) => [p.failed, p.passed, p.match]),
        [...new Set(attempts.map((a) => a.cell))].map((cell) => [`${cell}#2`, `${cell}#1`, 'cell']),
        harness,
      )
      const failed = attempts.find((a) => a.id === `${harness}/edit and run#2`) as AttemptView
      const passed = attempts.find((a) => a.id === `${harness}/edit and run#1`) as AttemptView
      const d = divergence(failed, passed)
      assert.deepEqual(
        [d.stepsInCommon, d.divergedAt, d.failedSteps],
        [0, 1, []],
        `${harness}: the canary never reached the agent`,
      )
      assert.deepEqual(d.passedSteps, passed.turns[0]?.steps.slice(0, 6), harness)
      assert.deepEqual(d.files, { onlyFailed: [], onlyPassed: ['notes.txt'] }, harness)
      assert.match(d.diff.passed, /^\+\+\+ b\/notes\.txt$/m, harness)
    }
    // Two passing runs of one eval on a real harness: equal up to the first differing step.
    for (const harness of REAL_HARNESSES) {
      const [a, b] = await Promise.all(
        realAttempts('real-e2e-pairs')
          .filter((r) => r.harness === harness)
          .map((r) => fromRecorded(realRunDir(r), r.attempt)),
      )
      const x = (a as AttemptView).turns.flatMap((t) => t.steps)
      const y = (b as AttemptView).turns.flatMap((t) => t.steps)
      const d = divergence(a as AttemptView, b as AttemptView)
      assert.deepEqual(x.slice(0, d.stepsInCommon), y.slice(0, d.stepsInCommon), harness)
      if (d.divergedAt === null) assert.deepEqual(x, y, harness)
      else assert.notEqual(x[d.stepsInCommon], y[d.stepsInCommon], harness)
    }
  })

  test('the analyst replays each real harness\u2019s contract run on the fake model, within its input budget', async () => {
    for (const harness of REAL_HARNESSES) {
      const attempts = await contractGroup(harness)
      const note = (maxInputTokens: number) =>
        writeAgentNote({
          model: {
            name: 'fake',
            route: 'fake',
            fake: fakeAnalysis({ note: (input) => JSON.stringify(input) }),
          },
          runId: 'replay',
          evalId: 'the harness contract',
          harness,
          attempts,
          maxInputTokens,
          maxOutputTokens: 8000,
        })
      const full = await note(20_000)
      assert.equal(full.error, undefined, harness)
      assert.deepEqual(
        full.attempts,
        attempts.map((a) => a.id),
        harness,
      )
      const input = JSON.parse(full.text)
      assert.deepEqual(
        input.attempts.map((a: { outcome: string }) => a.outcome),
        attempts.map((a) => a.outcome),
        harness,
      )
      assert.deepEqual(
        input.compared,
        listOutcomes(attempts)
          .pairs.slice(0, 3)
          .map((p) => ({
            failed: p.failed,
            passed: p.passed,
            // The canary has no steps, so they part at the passing run's first one, if it has any.
            divergedAt: attempts.find((a) => a.id === p.passed)?.turns.some((t) => t.steps.length)
              ? 1
              : null,
          })),
        `${harness}: three failed-vs-passing pairs, compared on real traces`,
      )
      // At the smallest budget the listing fits, then the comparisons run out; the note is still written.
      const tight = await note(1000)
      const compared = JSON.parse(tight.text).compared
      assert.equal(tight.error, undefined, harness)
      assert.ok(
        compared.length > 0 && compared.length < 3,
        `${harness}: ${compared.length} compared`,
      )
    }
  })

  test('a fake run writes one note per eval and harness, with its attempt ids; outcomes stand', async () => {
    const p = await project('agent-notes', {
      'reeval.config.ts': AGENT_CONFIG(
        `analysis: { agent: true, model: fakeAnalysis({ note: (i) => { called(); return JSON.stringify(i) } }) },`,
      ),
      ...AGENT_EVALS,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, 'wobbly#2 fails its check, as it would without notes')
    const { runId, names, notes } = notesOf(p.dir)
    assert.match(
      r.stdout,
      new RegExp(`^analysis: 4 notes in \\.reeval/analysis/${runId}/notes$`, 'm'),
    )
    assert.equal(calls(p.dir), 4)
    assert.deepEqual(
      notes.map((n) => [n.evalId, n.harness, n.attempts]),
      [
        ['evals/w.eval.ts › reads ok.txt', 'steady', ['steady/fake/fake#1']],
        ['evals/w.eval.ts › reads ok.txt', 'wobbly', ['wobbly/fake/fake#1']],
        [
          'evals/w.eval.ts › writes ok.txt',
          'steady',
          ['steady/fake/fake#1', 'steady/fake/fake#2', 'steady/fake/fake#3'],
        ],
        [
          'evals/w.eval.ts › writes ok.txt',
          'wobbly',
          ['wobbly/fake/fake#1', 'wobbly/fake/fake#2', 'wobbly/fake/fake#3'],
        ],
      ].sort((a, b) =>
        noteFileName(a[0] as string, a[1] as string).localeCompare(
          noteFileName(b[0] as string, b[1] as string),
        ),
      ),
    )
    assert.deepEqual(
      names,
      notes.map((n) => noteFileName(n.evalId, n.harness)),
    )
    const wobbly = notes.find((n) => n.harness === 'wobbly' && n.evalId.endsWith('writes ok.txt'))
    const input = JSON.parse(wobbly?.text ?? '{}')
    assert.deepEqual(input.compared, [
      { failed: 'wobbly/fake/fake#2', passed: 'wobbly/fake/fake#1', divergedAt: null },
    ])
    assert.deepEqual(
      input.attempts.map((a: { outcome: string }) => a.outcome),
      ['pass', 'fail', 'pass'],
    )

    const record = readRun(p.dir).run
    assert.equal(record.runId, runId)
    assert.deepEqual(
      record.evals.map((e) => [e.name, e.outcome]),
      [
        ['writes ok.txt', 'fail'],
        ['reads ok.txt', 'pass'],
      ],
    )
    const doc: ShapeSchema = JSON.parse(
      readFileSync(join(pkgRoot, 'schema/analysis-note.schema.json'), 'utf8'),
    )
    for (const note of await listNotes(p.dir, runId)) {
      assert.deepEqual(validate(doc, readableAnalysisNote(note)), [], note.evalId)
      assert.deepEqual(
        [note.kind, note.schemaVersion, note.model, note.error],
        ['reeval-analysis-note', 1, 'fake', undefined],
      )
    }
    assert.throws(
      () => readableAnalysisNote({ ...(notes[0] as AnalysisNote), schemaVersion: 2 as never }),
      NewerSchemaError,
    )
    assert.deepEqual(
      (await listAnalyses(p.dir, [join(p.dir, 'evals/.history')], runId, true)).map((e) =>
        /^\.reeval\/analysis\/[0-9a-f]{64}\.json$/.test(e.file),
      ),
      [true],
      "the notes' folder in the cache isn't an analysis: the run's summary is the only one",
    )
  })

  test('a note that errors is written with its error and a warning; the run still passes', async () => {
    const p = await project('agent-note-error', {
      'reeval.config.ts': AGENT_CONFIG(
        `analysis: { agent: true, model: fakeAnalysis({ note: { error: 'the model is down' } }) },`,
      ),
      'evals/w.eval.ts': AGENT_EVALS['evals/w.eval.ts'].replace(
        "c.attempt.cell.harness === 'wobbly' && c.attempt.n === 2",
        'false',
      ),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^analysis note on evals\/w\.eval\.ts › writes ok\.txt \(wobbly\) failed: the model is down$/m,
    )
    assert.match(r.stdout, /^analysis: 4 notes \(4 failed\) in /m)
    assert.match(r.stdout, /8 passed \(8 attempts, 2 evals\)/)
    const { notes } = notesOf(p.dir)
    assert.ok(notes.every((n) => n.error === 'the model is down' && n.text === ''))
    assert.ok(readRun(p.dir).run.evals.every((e) => e.outcome === 'pass'))
  })

  test('without agent, a run makes no analysis call, even with analysis.model set', async () => {
    for (const agent of ['', 'agent: false,']) {
      const p = await project('agent-off', {
        'reeval.config.ts': AGENT_CONFIG(
          `analysis: { ${agent} model: fakeAnalysis({ note: () => { called(); return 'x' } }) },`,
        ),
        ...AGENT_EVALS,
      })
      assert.equal((await runCli(p.dir)).code, 1)
      assert.equal(calls(p.dir), 0, agent || 'agent unset')
      assert.equal(existsSync(join(p.dir, '.reeval/analysis')), false)
    }
  })

  test('agent without a language model exits 2 at plan time; --dry-run still plans', async () => {
    const cases: Array<[string, RegExp]> = [
      [
        'analysis: { agent: true },',
        /config\.analysis\.agent needs a language model\. Set analysis: \{ model: 'google\/gemini-3\.8-flash' \} in reeval\.config\.ts \(the judge, a fake judge, is an evaluation model: it scores yes\/no questions and can't write an analysis\), or turn agent off\./,
      ],
      [
        "analysis: { agent: true, model: 'typesafe-ai/jev-1.13.0' },",
        /config\.analysis\.model "typesafe-ai\/jev-1\.13\.0" is an evaluation model/,
      ],
      [
        "analysis: { agent: true, model: 'google/gemini-3.8-flash' },",
        /Missing credentials: GOOGLE_GENERATIVE_AI_API_KEY or AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN\./,
      ],
    ]
    for (const [analysis, message] of cases) {
      const p = await project('agent-no-model', {
        'reeval.config.ts': AGENT_CONFIG(analysis),
        ...AGENT_EVALS,
      })
      const r = await runCli(p.dir)
      assert.equal(r.code, 2, analysis)
      assert.match(r.stderr, message, analysis)
      assert.equal(existsSync(join(p.dir, 'sandboxes')), false, 'no attempt ran')
      const dry = await runCli(p.dir, ['run', '--dry-run'])
      assert.equal(dry.code, 0, dry.stderr)
    }
  })
})

/** A project whose history is a copy of `history`, and its config resolved in-process. */
async function summaryInputs(history: string, maxInputTokens = 20_000, output: unknown = {}) {
  const dir = tempDir('summary-replay')
  cpSync(history, join(dir, 'evals/.history'), { recursive: true })
  const config = resolveConfig(
    { analysis: { model: fakeAnalysis({ output }), maxInputTokens } } as never,
    dir,
  )
  const entries = await allRuns(config)
  /** The run's digest, against the base `reeval analyze` picks, or (`alone`) none. */
  const prepare = async (runId: string, alone = false) => {
    const head = entries.find((e) => e.runId === runId) as HistoryEntry
    const base = alone ? null : await defaultBase(config, entries, head)
    return prepareAnalysis(config, head, base, null)
  }
  return { config, entries, prepare, model: resolveAnalysisModel(config) }
}

const callTool = (
  tools: ReturnType<typeof summaryTools>,
  name: keyof ReturnType<typeof summaryTools>,
  input: object,
) =>
  (tools[name].execute as (i: object, o: object) => Promise<unknown>)(input, {
    toolCallId: 't',
    messages: [],
  })

/** A canned summary whose claims cite `good` and a made-up attempt, one claim each. */
const citing = (good: string[]) => ({
  tldr: 'A summary.',
  whatHappened: [
    { text: 'What the cited items show.', cites: good, confidence: 'high' },
    { text: 'An attempt that never ran.', cites: ['r9/nope/control#1'], confidence: 'high' },
  ],
  results: [],
  why: [],
  anomalies: [],
  actions: [],
  confidence: { overall: 'medium', why: 'A replay.' },
})

const summaryDocs = (dir: string) =>
  readdirSync(join(dir, '.reeval/analysis'))
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({
      key: n.slice(0, -5),
      doc: JSON.parse(readFileSync(join(dir, '.reeval/analysis', n), 'utf8')),
    }))

describe("analysis.agent: the run's summary after reeval run", () => {
  test('on a real Cursor history, the tools read back dropped evidence and a failing attempt, and citations to what they read are valid', async () => {
    const { config, prepare, model } = await summaryInputs(join(FIXTURES, 'dogfood'), 8000)
    const p = await prepare(HEAD)
    assert.equal(p.base?.runId, BASE)
    assert.deepEqual(
      p.dropped.map((e) => e.id),
      p.digest.dropped,
      'every dropped item is kept whole',
    )
    assert.ok(p.dropped.length >= 3, `${p.dropped.length} dropped at the cap`)

    const { reads } = await investigate(p, model, config)
    assert.deepEqual(
      reads.map((r) => [r.tool, r.input]),
      [
        ...p.digest.dropped.slice(0, 3).map((id) => ['read_evidence', { id }]),
        ['open_attempt', { id: 'r2/fix-config/control#1' }],
      ],
      'the fake reads what the prompt asks for: dropped evidence and the failing attempt',
    )
    const failed = reads.at(-1)?.output as ReturnType<typeof attemptSummary>
    assert.equal(failed.outcome, 'fail')
    assert.ok(failed.turns.flatMap((t) => t.steps).length > 3, 'the real transcript as steps')
    const read = toolReads(reads)
    assert.deepEqual(
      read.evidence.map((e) => e.id),
      p.digest.dropped.slice(0, 3),
    )
    const [first] = read.evidence
    const line = first?.lines.find((l) => /^L\d+ /.test(l))?.split(' ')[0]
    assert.ok(line, 'a dropped tool strip keeps its transcript lines')
    const size = reads.reduce((n, r) => n + JSON.stringify(r.output).length, 0)
    assert.ok(size <= config.analysis.maxInputTokens * 4, `${size} characters read`)

    const fake = (cites: string[]) => ({
      name: 'fake',
      route: 'fake' as const,
      fake: fakeAnalysis({ output: citing(cites) }),
    })
    const cite = `${first?.id}:${line}`
    const doc = await analyseDigest(config, p, fake([cite, 'r2/fix-config/control#1']), read)
    assert.deepEqual(
      doc.analysis.whatHappened.map((c) => c.text),
      ['What the cited items show.'],
      'the made-up attempt is dropped; the dropped evidence, once read, is citable',
    )
    assert.deepEqual(doc.validation.invalid, ['whatHappened[1]: r9/nope/control#1'])
    assert.match(doc.cited[cite] ?? '', new RegExp(`^${line} `))
    assert.equal(
      (await analyseDigest(config, p, fake([cite]))).validation.invalid[0],
      `whatHappened[0]: ${cite}`,
      'unread, a dropped item is not citable',
    )
  })

  test('on each real harness\u2019s contract run, the tools open real attempts and diffs, and a made-up citation is rejected', async () => {
    const history = join(pkgRoot, 'test/fixtures/records/real-contract/evals/.history')
    const { config, entries, prepare, model } = await summaryInputs(history)
    const byHarness = new Map(
      realAttempts('real-contract').map((r) => [r.harness, r.runId] as const),
    )
    assert.deepEqual([...byHarness.keys()].sort(), [...REAL_HARNESSES].sort())
    assert.equal(entries.length, 3)
    // Each run is a different harness, so each is analysed alone.
    for (const [harness, runId] of byHarness) {
      const p = await prepare(runId, true)
      const attempts = Object.entries(p.digest.attempts)
      assert.equal(attempts.length, 12, harness)
      const { reads } = await investigate(p, model, config)
      const failing = attempts.filter(([, a]) => a.outcome === 'fail').map(([id]) => id)
      assert.deepEqual(
        reads.map((r) => (r.input as { id: string }).id),
        failing.slice(0, 3),
        `${harness}: the fake opens three of the failing canaries`,
      )
      for (const r of reads) {
        const opened = r.output as ReturnType<typeof attemptSummary>
        assert.equal(opened.outcome, 'fail', harness)
      }
      const tools = summaryTools(p, config.analysis.maxInputTokens * 4)
      const [edit] =
        attempts.find(([, a]) => /edit-and-run/.test(a.evalSlug) && a.outcome === 'pass') ?? []
      assert.ok(edit, `${harness}: the passing edit-and-run attempt`)
      const opened = (await callTool(tools, 'open_attempt', { id: edit })) as ReturnType<
        typeof attemptSummary
      >
      assert.match(opened.diff, /^\+\+\+ b\/notes\.txt$/m, `${harness}: its real diff`)
      assert.ok(opened.turns.flatMap((t) => t.steps).length > 0, harness)
      assert.match(
        String(
          ((await callTool(tools, 'open_attempt', { id: 'r9/nope#1' })) as { error: string }).error,
        ),
        /^No attempt r9\/nope#1\. The attempts are /,
      )
      assert.match(
        String(((await callTool(tools, 'read_evidence', { id: 'E1' })) as { error: string }).error),
        /^No dropped evidence E1\. Dropped: none\.$/,
      )

      const fake = fakeAnalysis({ output: citing([failing[0] as string, edit as string]) })
      const doc = await analyseDigest(
        config,
        p,
        { name: 'fake', route: 'fake', fake },
        toolReads(reads),
      )
      assert.deepEqual(doc.validation.invalid, ['whatHappened[1]: r9/nope/control#1'], harness)
      assert.deepEqual(doc.analysis.whatHappened[0]?.cites, [failing[0], edit], harness)
      assert.equal(doc.attempts[edit as string]?.runId, runId, harness)
    }
  })

  test('a fake run caches one run-scoped summary; reeval analyze on the run is served from it', async () => {
    const summary = `analysis: { agent: true, model: fakeAnalysis({
      note: 'A note.',
      output: (d) => {
        appendFileSync(new URL('./summary.log', import.meta.url), 'call\\n')
        const failed = Object.keys(d.attempts).find((id) => d.attempts[id].outcome === 'fail')
        return { tldr: 'wobbly#2 missed its file.', whatHappened: [
          { text: 'One attempt failed.', cites: [failed], confidence: 'high' },
          { text: 'An attempt that never ran.', cites: ['r9/nope/control#1'], confidence: 'high' },
        ], results: [], why: [], anomalies: [], actions: [], confidence: { overall: 'low', why: 'A fake.' } }
      },
    }) },`
    const p = await project('agent-summary', {
      'reeval.config.ts': AGENT_CONFIG(summary),
      ...AGENT_EVALS,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, 'wobbly#2 fails its check, as it would without a summary')
    const [cached, ...more] = summaryDocs(p.dir)
    assert.ok(cached)
    assert.equal(more.length, 0, 'one summary per run')
    const { runId } = notesOf(p.dir)
    assert.match(
      r.stdout,
      new RegExp(
        `^analysis: 4 notes in \\.reeval/analysis/${runId}/notes\\nanalysis: summary in \\.reeval/analysis/${cached.key}\\.json \\(reeval analyze shows it\\)$`,
        'm',
      ),
    )
    const summaryCalls = () =>
      readFileSync(join(p.dir, 'summary.log'), 'utf8').split('\n').filter(Boolean).length
    assert.equal(summaryCalls(), 1)
    const doc = cached.doc
    assert.deepEqual(
      [doc.kind, doc.scope, doc.anchor, doc.error, doc.model],
      [
        'es-analysis',
        { kind: 'run', head: runId, base: null, evals: null },
        runId,
        undefined,
        'fake',
      ],
    )
    assert.deepEqual(
      doc.analysis.whatHappened.map((c: { cites: string[] }) => c.cites),
      [['r1/w-1/wobbly:control#2']],
      'validateAnalysis dropped the made-up citation',
    )
    assert.deepEqual(doc.validation.invalid, ['whatHappened[1]: r9/nope/control#1'])
    const schema: ShapeSchema = JSON.parse(
      readFileSync(join(pkgRoot, 'schema/analysis.schema.json'), 'utf8'),
    )
    assert.deepEqual(validate(schema, readableAnalysis(doc)), [])

    const again = await runCli(p.dir, ['analyze', '--json'])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stderr, /^cached analysis from /)
    assert.equal(summaryCalls(), 1, 'reeval analyze made no call')
    assert.deepEqual(JSON.parse(again.stdout), doc)
    assert.match((await runCli(p.dir, ['analyze', '--dry-run'])).stdout, /cache hit/)
  })

  test('a summary that fails is cached with its error and a warning; the run passes, and reeval analyze calls again', async () => {
    const failing = `analysis: { agent: true, model: fakeAnalysis({ note: 'A note.', output: () => { throw new Error('the model is down') } }) },`
    const p = await project('agent-summary-error', {
      'reeval.config.ts': AGENT_CONFIG(failing),
      'evals/w.eval.ts': AGENT_EVALS['evals/w.eval.ts'].replace(
        "c.attempt.cell.harness === 'wobbly' && c.attempt.n === 2",
        'false',
      ),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /^analysis summary failed: the model is down$/m)
    assert.match(r.stdout, /8 passed \(8 attempts, 2 evals\)/)
    const [cached] = summaryDocs(p.dir)
    assert.equal(cached?.doc.error, 'the model is down')
    assert.equal(cached?.doc.analysis.tldr, '')
    const { runId } = notesOf(p.dir)
    const listed = await listAnalyses(p.dir, [join(p.dir, 'evals/.history')], runId, true)
    assert.deepEqual(
      listed.map((e) => e.doc.error),
      ['the model is down'],
      'the studio lists it, error and all',
    )
    assert.ok(readRun(p.dir).run.evals.every((e) => e.outcome === 'pass'))

    const config = join(p.dir, 'reeval.config.ts')
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace(
        "() => { throw new Error('the model is down') }",
        "{ tldr: 'It works now.', whatHappened: [], results: [], why: [], anomalies: [], actions: [], confidence: { overall: 'low', why: 'x' } }",
      ),
    )
    const again = await runCli(p.dir, ['analyze'])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stderr, /^analysing /, 'a cached failure is a miss')
    assert.match(again.stdout, /It works now\./)
    assert.deepEqual(
      summaryDocs(p.dir).map((d) => [d.key, d.doc.error]),
      [[cached?.key, undefined]],
      'the same key, now without the error',
    )
  })
})
