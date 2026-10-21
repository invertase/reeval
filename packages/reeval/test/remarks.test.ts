import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { RunRecord } from '../src/history/types.ts'
import { defaultBranch } from '../src/remarks/index.ts'
import {
  type CheckWindow,
  deterministicRemarks,
  type RemarkContext,
  type Streak,
} from '../src/remarks/rules.ts'
import type { RunInsights } from '../src/view/insights.ts'
import { suiteResult } from '../src/view/suite.ts'
import { baseEnv, fakeConfig, project, readRun, recordedRuns, runCli } from './helpers.ts'

const GIT_ENV = {
  ...baseEnv,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

/** A compare whose variant passes `variant` of its tries and whose baseline passes `base`. */
const compareEval = (runs: number, variant: number, base: number) => `
import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\\n' } })
evaluate('skill helps', { runs: ${runs}, compare: { baseline: plain, variants: [marked] } }, async (c) => {
  await c.send('go')
  const wins = c.attempt.cell.role === 'variant' ? ${variant} : ${base}
  expect.soft(c.attempt.n <= wins, 'uses the marker').toBe(true)
})
`

/** An MCP server that starts answering `delay` ms after it's spawned, in order. */
const slowServer = (delay: number) => `
import { createInterface } from 'node:readline'
const ready = new Promise((resolve) => setTimeout(resolve, ${delay}))
const send = (m) => ready.then(() => process.stdout.write(JSON.stringify(m) + '\\n'))
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  const result = m.method === 'initialize'
    ? { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '1.0.0' } }
    : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'ok' }] } : {}
  send({ jsonrpc: '2.0', id: m.id, result })
})
`

const mcpEval = (command: string) => `
import { defineEnvironment, evaluate, expect } from 'reeval'
const docs = defineEnvironment('docs', ({ file, mcp }) => ({
  files: { 'server.mjs': file('../server.mjs') },
  mcp: { docs: mcp.stdio(${command}) },
}))
evaluate('looks it up', { environment: docs }, async (c) => {
  await c.send('look it up')
  await c.send('and again')
  expect(true, 'answered').toBe(true)
})
`
const mcpConfig = fakeConfig({
  harness: `{ script: [[{ mcp: 'docs/lookup' }, { reply: 'one' }], [{ mcp: 'docs/lookup' }, { reply: 'two' }]] }`,
})

const NO_HISTORY: RemarkContext = {
  history: null,
  comparable: () => 'fp',
  locate: (entry) => `source:${entry.file}`,
}

/** A context whose history answers every cell and check with `streak`, `flaky` and `window`. */
const withHistory = (h: {
  streak?: Streak | null
  flaky?: { cause: string } | null
  window?: CheckWindow
}): RemarkContext => ({
  ...NO_HISTORY,
  history: {
    streak: () => h.streak ?? null,
    flaky: () => h.flaky ?? null,
    window: () => h.window ?? { runs: 0, mixed: 0, pass: 0, fail: 0 },
  },
})

const raise = (record: RunRecord, ctx: RemarkContext) =>
  deterministicRemarks(suiteResult(record), record, ctx)
const kinds = (record: RunRecord, ctx: RemarkContext) => raise(record, ctx).map((r) => r.kind)

const insightsOf = (dir: string): RunInsights | null => {
  const run = readRun(dir)
  const file = join(run.dir, 'insights.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

const remarksBlock = (stdout: string) => {
  const at = stdout.indexOf('\nRemarks:')
  return at < 0 ? null : stdout.slice(at + 1)
}

/** A record of one fake run of `files`, for the rules to read with a stubbed history. */
async function recordOf(name: string, files: Record<string, string>): Promise<RunRecord> {
  const p = await project(name, files)
  const r = await runCli(p.dir, ['run'])
  assert.notEqual(r.code, 2, r.stdout + r.stderr)
  return readRun(p.dir).run
}

describe('remark thresholds', () => {
  test('too-few-tries: a gap of half the tries with fewer than 4 a side, not under it', async () => {
    const config = fakeConfig()
    const at = await recordOf('remarks-tft-at', {
      'reeval.config.ts': config,
      'evals/skill.eval.ts': compareEval(2, 2, 1),
    })
    const [remark] = raise(at, NO_HISTORY)
    assert.equal(remark?.kind, 'too-few-tries')
    assert.equal(remark?.severity, 'suggestion')
    assert.equal(
      remark?.text,
      'Marked passed 2 of 2 tries and plain 1 of 2: too few tries to tell whether the difference holds.',
    )
    assert.equal(remark?.fix?.edit, 'set runs: 4 or more, so each side counts at least 4 tries')
    const gap = await recordOf('remarks-tft-gap', {
      'reeval.config.ts': config,
      'evals/skill.eval.ts': compareEval(3, 2, 1),
    })
    assert.deepEqual(kinds(gap, NO_HISTORY), [], 'a gap of a third is under the threshold')
    const enough = await recordOf('remarks-tft-enough', {
      'reeval.config.ts': config,
      'evals/skill.eval.ts': compareEval(4, 4, 0),
    })
    assert.deepEqual(kinds(enough, NO_HISTORY), [], '4 tries a side can tell')
  })

  test('check-never-fails: 5 clean recorded runs and 20 tries, not 4 runs or 19 tries', async () => {
    const record = await recordOf('remarks-cnf', {
      'reeval.config.ts': fakeConfig(),
      'evals/clean.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('clean', { runs: 4 }, async (c) => {
  await c.send('go')
  expect(1, 'always one').toBe(1)
})
`,
    })
    const [remark] = raise(record, withHistory({ streak: { runs: 5, tries: 20 } }))
    assert.equal(remark?.kind, 'check-never-fails')
    assert.equal(
      remark?.text,
      '"always one" passed every try in the last 5 recorded runs (20 tries), so it never tells a good result from a bad one.',
    )
    assert.deepEqual(kinds(record, withHistory({ streak: { runs: 4, tries: 20 } })), [])
    assert.deepEqual(kinds(record, withHistory({ streak: { runs: 5, tries: 19 } })), [])
    assert.deepEqual(kinds(record, NO_HISTORY), [])
  })

  test('flaky-check: flaky, 2 mixed runs and 6 tries, not 1 mixed run, 5 tries or infra', async () => {
    const record = await recordOf('remarks-flaky', {
      'reeval.config.ts': fakeConfig(),
      'evals/coin.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('coin', { runs: 2 }, async (c) => {
  await c.send('go')
  expect.soft(c.attempt.n, 'lands heads').toBe(1)
})
`,
    })
    const window = { runs: 3, mixed: 2, pass: 3, fail: 3 }
    const [remark] = raise(record, withHistory({ flaky: { cause: 'agent' }, window }))
    assert.equal(remark?.kind, 'flaky-check')
    assert.equal(remark?.severity, 'concern')
    assert.equal(
      remark?.text,
      '"lands heads" passed 3 of 6 tries over 3 runs with nothing changed, so one try can pass or fail it.',
    )
    const flaky = { cause: 'agent' }
    assert.deepEqual(kinds(record, withHistory({ flaky, window: { ...window, mixed: 1 } })), [])
    assert.deepEqual(kinds(record, withHistory({ flaky, window: { ...window, fail: 2 } })), [])
    assert.deepEqual(kinds(record, withHistory({ flaky: { cause: 'infra' }, window })), [])
    assert.deepEqual(kinds(record, withHistory({ flaky: null, window })), [])
  })

  test('slow-mcp-start: 2000 ms or no answer on a recorded turn, not 1999 ms', async () => {
    const record = await recordOf('remarks-mcp', {
      'reeval.config.ts': mcpConfig,
      'server.mjs': slowServer(0),
      'evals/docs.eval.ts': mcpEval(`'node', ['server.mjs']`),
    })
    const starts = record.evals[0]?.attempts[0]?.turns.map((t) => t.mcpStartup ?? []) ?? []
    assert.equal(starts.length, 2, 'the fake harness starts its servers each turn')
    assert.ok(starts.every((s) => s.length === 1 && s[0]?.server === 'docs'))
    const timed = (ms: Array<number | null>, server = 'docs') => {
      const copy = structuredClone(record)
      for (const [i, turn] of (copy.evals[0]?.attempts[0]?.turns ?? []).entries()) {
        turn.mcpStartup = [{ server, ms: ms[i] === undefined ? 0 : ms[i] }]
      }
      return copy
    }
    assert.deepEqual(kinds(timed([1999, 1999]), NO_HISTORY), [])
    const [both] = raise(timed([4000, 4000]), NO_HISTORY)
    assert.equal(both?.kind, 'slow-mcp-start')
    assert.equal(both?.severity, 'concern')
    assert.equal(both?.text, 'MCP server docs took 4s to start on each of 2 turns.')
    const [one] = raise(timed([2000, 1999]), NO_HISTORY)
    assert.equal(one?.text, 'MCP server docs took 2s to start on 1 of 2 turns.')
    const [never] = raise(timed([null, 30]), NO_HISTORY)
    assert.equal(
      never?.text,
      'MCP server docs never answered within the start-up timeout on 1 of 2 turns.',
    )
    const [plugin] = raise(timed([4000, 4000], 'review:lint'), NO_HISTORY)
    assert.equal(
      plugin?.text,
      "The review plugin's MCP server lint took 4s to start on each of 2 turns.",
    )
    const session = timed([4000, 4000])
    for (const turn of session.evals[0]?.attempts[0]?.turns.slice(1) ?? []) delete turn.mcpStartup
    assert.equal(
      raise(session, NO_HISTORY)[0]?.text,
      'MCP server docs took 4s to start.',
      'a session harness records its servers on turn 1 only, so there is no turn count',
    )
  })
})

describe('remarks in reeval run', () => {
  test('a suggestion prints under -v once per eval version, and an edit re-arms it', async () => {
    const p = await project('remarks-run', {
      'reeval.config.ts': fakeConfig(),
      'evals/skill.eval.ts': compareEval(2, 2, 0),
    })
    const quiet = await runCli(p.dir, ['run'])
    assert.equal(quiet.code, 0, quiet.stderr)
    assert.equal(remarksBlock(quiet.stdout), null, 'suggestions print under -v only')
    const insights = insightsOf(p.dir)
    assert.equal(insights?.model, 'none')
    assert.deepEqual(
      insights?.remarks.map((r) => [r.kind, r.origin, r.firstSeenRun]),
      [['too-few-tries', 'deterministic', insights?.runId]],
    )
    const summary = readRun(p.dir).read('summary.md')
    assert.doesNotMatch(summary, /Remarks:/)
    const later = await runCli(p.dir, ['run', '-v'])
    assert.match(
      remarksBlock(later.stdout) ?? '',
      /too few tries/,
      'a suggestion a run without -v hid prints in the next -v run',
    )
    const shown = insightsOf(p.dir)?.remarks[0]
    const again = await runCli(p.dir, ['run', '-v'])
    assert.equal(remarksBlock(again.stdout), null, 'once printed, it does not print again')
    assert.deepEqual(
      [insights?.remarks[0]?.printed, shown?.printed, insightsOf(p.dir)?.remarks[0]?.printed],
      [false, true, false],
    )
    assert.equal(shown?.firstSeenRun, insightsOf(p.dir)?.remarks[0]?.firstSeenRun)

    const p2 = await project('remarks-run-v', {
      'reeval.config.ts': fakeConfig(),
      'evals/skill.eval.ts': compareEval(2, 2, 0),
    })
    const first = await runCli(p2.dir, ['run', '-v'])
    assert.equal(
      remarksBlock(first.stdout),
      [
        'Remarks:',
        '  skill helps: Marked passed 2 of 2 tries and plain 0 of 2: too few tries to tell whether the difference holds.',
        '    fix  evals/skill.eval.ts:5  set runs: 4 or more, so each side counts at least 4 tries',
        '',
      ].join('\n'),
    )
    const firstRun = readRun(p2.dir).run.runId
    const second = await runCli(p2.dir, ['run', '-v'])
    assert.equal(remarksBlock(second.stdout), null, 'printed once per eval version')
    assert.equal(insightsOf(p2.dir)?.remarks[0]?.firstSeenRun, firstRun)

    await writeFile(
      join(p2.dir, 'evals/skill.eval.ts'),
      compareEval(2, 2, 0).replace("'go'", "'go now'"),
    )
    const edited = await runCli(p2.dir, ['run', '-v'])
    assert.match(remarksBlock(edited.stdout) ?? '', /too few tries/, 'an edited eval re-arms it')
  })

  test('a concern the cap hid prints in the next -v run, then never again', async () => {
    const coins = ['one', 'two', 'three', 'four']
    const p = await project('remarks-cap', {
      'reeval.config.ts': fakeConfig(),
      'evals/coin.eval.ts': `import { evaluate, expect } from 'reeval'
${coins
  .map(
    (name) => `evaluate('coin ${name}', { runs: 3 }, async (c) => {
  await c.send('go')
  expect.soft(c.attempt.n, 'lands heads').toBe(1)
})`,
  )
  .join('\n')}
`,
    })
    for (let i = 0; i < 2; i++) await runCli(p.dir, ['run'])
    const capped = remarksBlock((await runCli(p.dir, ['run'])).stdout) ?? ''
    assert.match(capped, /\+1 more \(-v\)/)
    const named = (block: string) => [...block.matchAll(/^ {2}(coin \w+):/gm)].map((m) => m[1])
    assert.equal(named(capped).length, 3)
    const marks = insightsOf(p.dir)?.remarks.map((r) => r.printed)
    const verbose = remarksBlock((await runCli(p.dir, ['run', '-v'])).stdout) ?? ''
    assert.deepEqual(
      named(verbose),
      coins.map((c) => `coin ${c}`).filter((c) => !named(capped).includes(c)),
      'only the concern the cap hid',
    )
    const after = await runCli(p.dir, ['run', '-v'])
    assert.equal(remarksBlock(after.stdout), null, 'every concern has printed')
    assert.deepEqual(marks, [true, true, true, false])
  })

  test("an older reeval's remark, with no printed, counts as printed in the run that raised it", async () => {
    const p = await project('remarks-unmarked', {
      'reeval.config.ts': fakeConfig(),
      'evals/skill.eval.ts': compareEval(2, 2, 0),
    })
    await runCli(p.dir, ['run'])
    const file = join(readRun(p.dir).dir, 'insights.json')
    const doc = JSON.parse(readFileSync(file, 'utf8')) as RunInsights
    for (const r of doc.remarks) delete r.printed
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`)
    const later = await runCli(p.dir, ['run', '-v'])
    assert.equal(later.code, 0, later.stderr)
    assert.equal(remarksBlock(later.stdout), null)
  })

  test('a well-written eval prints no Remarks heading and writes no insights', async () => {
    const p = await project('remarks-none', {
      'reeval.config.ts': fakeConfig(),
      'evals/skill.eval.ts': compareEval(4, 4, 0),
    })
    for (let i = 0; i < 2; i++) {
      const r = await runCli(p.dir, ['run', '-v'])
      assert.equal(r.code, 0, r.stderr)
      assert.doesNotMatch(r.stdout, /Remarks:/)
      assert.equal(insightsOf(p.dir), null)
    }
  })

  test('slow-mcp-start prints in every run, at 2000 ms, and for a server that never answers', async () => {
    const p = await project('remarks-slow-mcp', {
      'reeval.config.ts': mcpConfig,
      'server.mjs': slowServer(2000),
      'evals/docs.eval.ts': mcpEval(`'node', ['server.mjs']`),
    })
    for (let i = 0; i < 2; i++) {
      const r = await runCli(p.dir, ['run'])
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(
        remarksBlock(r.stdout) ?? '',
        /^Remarks:\n {2}looks it up: MCP server docs took 2(\.\d)?s to start on each of 2 turns\.\n {4}fix {2}evals\/docs\.eval\.ts:5 {2}install what docs needs in the image/,
      )
    }
    const shown = await runCli(p.dir, ['show'])
    assert.match(shown.stdout, /Remarks:\n {2}looks it up: MCP server docs took/)

    const fast = await project('remarks-fast-mcp', {
      'reeval.config.ts': mcpConfig,
      'server.mjs': slowServer(0),
      'evals/docs.eval.ts': mcpEval(`'node', ['server.mjs']`),
    })
    const quick = await runCli(fast.dir, ['run'])
    assert.equal(quick.code, 0, quick.stdout + quick.stderr)
    assert.doesNotMatch(quick.stdout, /Remarks:/)

    const dead = await project('remarks-dead-mcp', {
      'reeval.config.ts': mcpConfig,
      'server.mjs': '',
      'evals/docs.eval.ts': mcpEval(`'node', ['-e', 'process.exit(1)']`),
    })
    const never = await runCli(dead.dir, ['run'])
    assert.match(
      remarksBlock(never.stdout) ?? '',
      /looks it up: MCP server docs never answered within the start-up timeout on each of 2 turns\.\n {4}fix {2}\S+ {2}run docs's command in the sandbox with c\.exec/,
    )
  })

  test('check-never-fails needs 5 recorded runs on the default branch, and goes to insights.json', async () => {
    const p = await project('remarks-streak', {
      '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
      'reeval.config.ts': fakeConfig(),
      'evals/clean.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('clean', { runs: 4 }, async (c) => {
  await c.send('go')
  expect(1, 'always one').toBe(1)
})
`,
    })
    sh(p.dir, 'init', '-q', '-b', 'main')
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'init')
    for (let i = 0; i < 5; i++) {
      const r = await runCli(p.dir, ['run', '--record', '-v'])
      assert.equal(r.code, 0, r.stderr)
      assert.doesNotMatch(r.stdout, /Remarks:/, `run ${i + 1} has ${i} recorded runs before it`)
    }
    const sixth = await runCli(p.dir, ['run', '--record', '-v'])
    assert.equal(
      remarksBlock(sixth.stdout)?.split('\n').slice(0, 3).join('\n'),
      [
        'Remarks:',
        '  clean: "always one" passed every try in the last 5 recorded runs (20 tries), so it never tells a good result from a bad one.',
        '    fix  evals/clean.eval.ts:4  make "always one" strict enough to fail on a wrong result, or remove it',
      ].join('\n'),
    )
    const recorded = recordedRuns(p.dir).at(-1) as string
    const doc = JSON.parse(
      readFileSync(join(p.dir, 'evals/.history', recorded, 'insights.json'), 'utf8'),
    ) as RunInsights
    assert.deepEqual(
      doc.remarks.map((r) => [r.kind, r.firstSeenRun]),
      [['check-never-fails', recorded]],
    )
    const summary = readFileSync(join(p.dir, 'evals/.history', recorded, 'summary.md'), 'utf8')
    assert.doesNotMatch(summary, /Remarks:/, 'summary.md prints concerns only')
    const seventh = await runCli(p.dir, ['run', '-v'])
    assert.equal(remarksBlock(seventh.stdout), null)
  })

  test("the default branch: origin's HEAD, a local main, then in CI a pull request's base", async () => {
    const p = await project('remarks-default-branch', { 'README.md': 'hi\n' })
    sh(p.dir, 'init', '-q', '-b', 'feature')
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'init')
    sh(p.dir, 'checkout', '-q', '--detach')
    sh(p.dir, 'branch', '-q', '-D', 'feature')
    const pr = { CI: 'true', GITHUB_BASE_REF: 'trunk' }
    assert.equal(await defaultBranch(p.dir, pr), 'trunk')
    assert.equal(await defaultBranch(p.dir, { GITHUB_BASE_REF: 'trunk' }), null, 'not outside CI')
    assert.equal(await defaultBranch(p.dir, { ...pr, CI: 'false' }), null)
    assert.equal(await defaultBranch(p.dir, { ...pr, GITHUB_BASE_REF: '' }), null, 'a push build')
    sh(p.dir, 'branch', '-q', 'master')
    assert.equal(await defaultBranch(p.dir, pr), 'master', 'a local branch comes first')
    sh(p.dir, 'update-ref', 'refs/remotes/origin/develop', 'HEAD')
    sh(p.dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    assert.equal(await defaultBranch(p.dir, pr), 'develop')
  })

  test('flaky-check prints once the cell has 2 mixed runs and 6 tries behind it', async () => {
    const p = await project('remarks-flaky-run', {
      'reeval.config.ts': fakeConfig(),
      'evals/coin.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('coin', { runs: 3 }, async (c) => {
  await c.send('go')
  expect.soft(c.attempt.n, 'lands heads').toBe(1)
})
`,
    })
    for (let i = 0; i < 2; i++) {
      const r = await runCli(p.dir, ['run'])
      assert.equal(r.code, 1, r.stderr)
      assert.doesNotMatch(r.stdout, /Remarks:/, `run ${i + 1}: ${3 * i} tries before it`)
    }
    const third = await runCli(p.dir, ['run'])
    assert.equal(third.code, 1, 'a remark never changes the exit code')
    assert.equal(
      remarksBlock(third.stdout)?.split('\n').slice(0, 3).join('\n'),
      [
        'Remarks:',
        '  coin: "lands heads" passed 2 of 6 tries over 2 runs with nothing changed, so one try can pass or fail it.',
        '    fix  evals/coin.eval.ts:4  make "lands heads" check something every good try does, or raise runs so one try doesn\'t decide it',
      ].join('\n'),
    )
    assert.match(readRun(p.dir).read('summary.md'), /Remarks:\n {2}coin: "lands heads"/)
    const fourth = await runCli(p.dir, ['run'])
    assert.doesNotMatch(fourth.stdout, /Remarks:/)
  })

  test('a fix points into its own eval when another eval in the file shares the label', async () => {
    const p = await project('remarks-shared-label', {
      'reeval.config.ts': fakeConfig(),
      'evals/coin.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('steady', { runs: 3 }, async (c) => {
  await c.send('go')
  expect.soft(1, 'lands heads').toBe(1)
})
evaluate('coin', { runs: 3 }, async (c) => {
  await c.send('go')
  expect.soft(c.attempt.n, 'lands heads').toBe(1)
})
`,
    })
    for (let i = 0; i < 2; i++) await runCli(p.dir, ['run'])
    const third = await runCli(p.dir, ['run'])
    assert.match(
      remarksBlock(third.stdout) ?? '',
      /^Remarks:\n {2}coin: "lands heads".*\n {4}fix {2}evals\/coin\.eval\.ts:8 /,
    )
  })

  test("a family's fix points at its name template", async () => {
    const p = await project('remarks-family', {
      'reeval.config.ts': fakeConfig(),
      'evals/fam.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\\n' } })
evaluate.each([{ id: 'a' }, { id: 'b' }])(
  'fixes $id',
  { runs: 2, compare: { baseline: plain, variants: [marked] } },
  async (c) => {
    await c.send('go')
    expect.soft(c.attempt.cell.role === 'variant', 'uses the marker').toBe(true)
  },
)
`,
    })
    const r = await runCli(p.dir, ['run', '-v'])
    assert.match(
      remarksBlock(r.stdout) ?? '',
      /^Remarks:\n {2}fixes \$id: Marked passed .*\n {4}fix {2}evals\/fam\.eval\.ts:5 /,
    )
  })
})
