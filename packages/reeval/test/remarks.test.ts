import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { EvalEntry, RunRecord } from '../src/history/types.ts'
import { sha256 } from '../src/ids.ts'
import type { InsightInput } from '../src/insights/input.ts'
import { gateRemarks } from '../src/insights/remarks.ts'
import { modelRubric, rubric, rubricHash, rubricKinds } from '../src/insights/rubric.ts'
import { insightsPromptVersion } from '../src/insights/schema.ts'
import { defaultBranch } from '../src/remarks/index.ts'
import {
  type CheckWindow,
  deterministicRemarks,
  type RemarkContext,
  type Streak,
} from '../src/remarks/rules.ts'
import { MODEL_REMARK_KINDS, REMARK_KINDS, type RunInsights } from '../src/view/insights.ts'
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

  test('proxy-only-egress: a connection error under proxy that reached no gateway, not under allow-all or a refusal', async () => {
    const record = await recordOf('remarks-proxy', {
      'reeval.config.ts': fakeConfig(),
      'evals/db.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('migrates', async (c) => {
  await c.send('go')
  expect('psql: Network is unreachable', 'migrated').toBe('ok')
})
`,
    })
    const egressed = (egress: Partial<NonNullable<EvalEntry['attempts'][number]['egress']>>) => {
      const copy = structuredClone(record)
      for (const a of copy.evals[0]?.attempts ?? []) {
        a.egress = {
          policy: 'proxy',
          allowed: null,
          recorded: true,
          contacted: [],
          blocked: [],
          expectedBlocked: [],
          ...egress,
        }
      }
      return copy
    }
    const [remark] = raise(egressed({}), NO_HISTORY)
    assert.equal(remark?.kind, 'proxy-only-egress')
    assert.equal(remark?.severity, 'concern')
    assert.equal(
      remark?.text,
      `It failed with "Network is unreachable" and nothing reached the egress gateway: under egress 'proxy' only HTTP(S) through the gateway leaves the sandbox, so raw TCP, UDP, SSH and database connections fail.`,
    )
    assert.match(remark?.fix.edit ?? '', /^set egress: 'allow-all' on the eval/)
    // Twins: under allow-all the connection went direct, and a refusal means it reached the gateway.
    assert.deepEqual(kinds(egressed({ policy: 'allow-all', partial: true }), NO_HISTORY), [])
    const refused = { host: 'db.example.com', port: 443, connections: 1, reason: 'denied' }
    assert.deepEqual(kinds(egressed({ blocked: [refused] }), NO_HISTORY), [])
    assert.deepEqual(kinds(egressed({ recorded: false }), NO_HISTORY), [])
  })

  test("setup-process-secret: a process setup left running with a to: 'checks' secret, not without one", async () => {
    const record = await recordOf('remarks-setup-process', {
      'reeval.config.ts': fakeConfig(),
      'evals/server.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const server = defineEnvironment('server', ({ secret }) => ({
  env: { CHECK_TOKEN: secret({ to: 'checks', optional: true }) },
}))
evaluate('serves', { runs: 2, environment: server }, async (c) => {
  await c.send('go')
  expect(true, 'served').toBe(true)
})
`,
    })
    assert.deepEqual(kinds(record, NO_HISTORY), [], 'the fake sandbox records no processes')
    const left = (...processes: Array<Array<{ command: string; secrets: string[] }>>) => {
      const copy = structuredClone(record)
      for (const [i, a] of (copy.evals[0]?.attempts ?? []).entries()) {
        if (processes[i]?.length) a.setupProcesses = processes[i]
      }
      return copy
    }
    const sleep = { command: 'sleep 600', secrets: ['CHECK_TOKEN'] }
    const [remark] = raise(left([sleep]), NO_HISTORY)
    assert.equal(remark?.kind, 'setup-process-secret')
    assert.equal(remark?.severity, 'concern')
    assert.equal(
      remark?.text,
      `Setup left "sleep 600" running with CHECK_TOKEN, a to: 'checks' secret without hosts, in its environment, so the agent can read the real value from that process.`,
    )
    assert.match(
      remark?.fix.edit ?? '',
      /^broker CHECK_TOKEN with the hosts the process sends it to/,
    )
    assert.equal(remark?.evidence.length, 1)
    const server = { command: 'node server.js', secrets: ['API_TOKEN', 'CHECK_TOKEN'] }
    const [both] = raise(left([sleep], [server]), NO_HISTORY)
    assert.equal(
      both?.text,
      `Setup left "sleep 600" (and 1 more) running with CHECK_TOKEN, API_TOKEN, to: 'checks' secrets without hosts, in their environment in 2 tries, so the agent can read the real value from those processes.`,
    )
    assert.equal(both?.evidence.length, 2)
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

  test('with model insights, a concern the cap hid prints in the next -v run', async () => {
    const coins = ['one', 'two', 'three', 'four']
    const p = await project('remarks-cap-insights', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { insights } from './insights.ts'
export default defineConfig({
  harness: fakeHarness(),
  environment: defineEnvironment('fake', {
    sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
  }),
  analysis: { model: fakeAnalysis({ insights }) },
})
`,
      'insights.ts': readFileSync(
        new URL('../scripts/output/project/insights.ts', import.meta.url),
        'utf8',
      ),
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
    const doc = insightsOf(p.dir)
    assert.notEqual(doc?.model, 'none', 'the model wrote the document')
    assert.deepEqual(
      doc?.remarks.map((r) => r.printed),
      [true, true, true, false],
    )
    const named = (block: string) => [...block.matchAll(/^ {2}(coin \w+):/gm)].map((m) => m[1])
    const verbose = await runCli(p.dir, ['run', '-v'])
    assert.deepEqual(
      named(remarksBlock(verbose.stdout) ?? ''),
      coins.map((c) => `coin ${c}`).filter((c) => !named(capped).includes(c)),
      'only the concern the cap hid',
    )
    const later = insightsOf(p.dir)
    assert.notEqual(later?.model, 'none')
    assert.deepEqual(
      later?.remarks.map((r) => r.printed),
      [false, false, false, true],
    )
    const runId = readRun(p.dir).run.runId
    assert.equal((await runCli(p.dir, ['record', runId])).code, 0)
    const recorded = JSON.parse(
      readFileSync(join(p.dir, 'evals/.history', runId, 'insights.json'), 'utf8'),
    ) as RunInsights
    assert.deepEqual(recorded.remarks, later?.remarks, 'recording keeps printed and firstSeenRun')
    const after = await runCli(p.dir, ['run', '-v'])
    assert.equal(remarksBlock(after.stdout), null, 'every concern has printed')
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

const REMARKS_DIR = new URL('./fixtures/remarks/', import.meta.url)
const KINDS_EVAL = readFileSync(new URL('kinds.eval.ts', REMARKS_DIR), 'utf8')

/** A fake project whose analysis model raises one remark per eval it knows (`fixtures/remarks`). */
const modelProject = (name: string, evals: string, extra = '') =>
  project(name, {
    'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { insights } from './insights.ts'
export default defineConfig({
  harness: fakeHarness(),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
  environment: defineEnvironment('fake', {}),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: { model: fakeAnalysis({ insights }) },
  ${extra}
})
`,
    'insights.ts': readFileSync(new URL('insights.ts', REMARKS_DIR), 'utf8'),
    'evals/kinds.eval.ts': evals,
  })

const MODEL_KINDS = [
  'name-contradicts',
  'name-no-intent',
  'judge-too-loose',
  'judge-leaks-answer',
  'compound-judge',
  'prompt-names-tool',
]

/** The evals a remarks block names, in order. */
const namedIn = (block: string | null) =>
  [...(block ?? '').matchAll(/^ {2}(\S[^:]*):/gm)].map((m) => m[1])

describe('model remarks', () => {
  test('each kind passes its gates, prints once with its fix, and never changes the exit code', async () => {
    const p = await modelProject('remarks-model-kinds', KINDS_EVAL)
    const first = await runCli(p.dir, ['run', '-v'])
    assert.equal(first.code, 1, 'ships the release fails its judge')
    const doc = insightsOf(p.dir)
    assert.deepEqual(doc?.validation.drops ?? [], [])
    assert.deepEqual(
      doc?.remarks.map((r) => [r.kind, r.origin, r.severity]).sort(),
      [
        ...MODEL_KINDS.map((k) => [
          k,
          'model',
          k === 'name-no-intent' || k === 'compound-judge' ? 'suggestion' : 'concern',
        ]),
        ['no-baseline', 'deterministic', 'concern'],
      ].sort(),
    )
    const block = remarksBlock(first.stdout) ?? ''
    assert.deepEqual(namedIn(block), [
      'answers kindly',
      'finds the bug',
      'adds a cache',
      'picks Genkit',
      'adds dark mode',
      'ships the release',
      'test 1',
    ])
    assert.match(
      block,
      /^ {2}answers kindly: The judge asks whether the answer is okay, which any reply passes\.\n {4}fix {2}evals\/kinds\.eval\.ts:16 {2}ask 'Does the reply thank the user by name and offer one next step\?'$/m,
    )
    const loose = doc?.remarks.find((r) => r.kind === 'judge-too-loose')
    assert.deepEqual(loose?.source, {
      at: 'source:evals/kinds.eval.ts#L16',
      quote: 'Is the answer okay?',
    })
    assert.match(
      loose?.evidence[0] ?? '',
      /answers kindly\/.*\/checks\/toPass Is the answer okay\?$/,
    )

    const off = await runCli(p.dir, ['run', '--no-insights'])
    assert.equal(off.code, first.code, 'the same exit code without the model')
    const second = await runCli(p.dir, ['run', '-v'])
    assert.equal(second.code, first.code)
    assert.equal(remarksBlock(second.stdout), null, 'every remark has printed')
  })

  test('without -v, concerns print up to the cap and suggestions wait', async () => {
    const p = await modelProject('remarks-model-cap', KINDS_EVAL)
    const r = await runCli(p.dir, ['run'])
    const block = remarksBlock(r.stdout)
    assert.deepEqual(namedIn(block), ['answers kindly', 'finds the bug', 'adds a cache'])
    assert.match(block ?? '', /\+2 more \(-v\)/)
  })

  test('canary: an unknown kind and a quote not on its line are dropped; evidence and a fix are not gated', async () => {
    const p = await modelProject('remarks-model-gates', KINDS_EVAL)
    const broken = [
      'name-contradicts:kind',
      'judge-leaks-answer:line',
      'judge-too-loose:evidence',
      'prompt-names-tool:fix',
    ]
    const r = await runCli(p.dir, ['run', '-v'], { env: { REMARKS: broken.join(',') } })
    assert.equal(r.code, 1)
    const doc = insightsOf(p.dir)
    assert.deepEqual(doc?.remarks.map((x) => x.kind).sort(), [
      'compound-judge',
      'judge-too-loose',
      'name-no-intent',
      'no-baseline',
      'prompt-names-tool',
    ])
    assert.deepEqual((doc?.validation.drops ?? []).map((d) => [d.slot, d.reason]).sort(), [
      ['adds a cache › remark vague-name', 'is kind "vague-name", which the model can\'t raise'],
      [
        'finds the bug › remark judge-leaks-answer',
        'quotes "off-by-one in parse()", which isn\'t on line 22 of evals/kinds.eval.ts',
      ],
    ])
    const block = remarksBlock(r.stdout) ?? ''
    assert.doesNotMatch(block, /adds a cache:|finds the bug:/)
    assert.match(block, /^ {2}answers kindly: .*\n {4}fix {2}evals\/kinds\.eval\.ts:16 /m)
    assert.match(
      block,
      /^ {2}picks Genkit: .*\n {4}at {3}evals\/kinds\.eval\.ts:30$/m,
      'without a fix, the remark points at its quoted line',
    )
  })

  test('canary: a remark whose quoted file changed since the run is dropped', async () => {
    const p = await modelProject('remarks-model-stale', KINDS_EVAL)
    await runCli(p.dir, ['run', '--no-insights'])
    await writeFile(join(p.dir, 'evals/kinds.eval.ts'), `${KINDS_EVAL}\n// edited\n`)
    const r = await runCli(p.dir, ['analyze', readRun(p.dir).run.runId, '--insights', '-v'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const drops = insightsOf(p.dir)?.validation.drops ?? []
    assert.equal(drops.length, 6, JSON.stringify(drops))
    for (const d of drops) assert.match(d.reason, /evals\/kinds\.eval\.ts changed since the run/)
  })

  test('an edit elsewhere in the file prints no model remark again', async () => {
    const p = await modelProject('remarks-model-edit', KINDS_EVAL)
    const raised = await runCli(p.dir, ['run', '-v'])
    assert.match(remarksBlock(raised.stdout) ?? '', /answers kindly:/)
    const edited = KINDS_EVAL.replace(
      "'toggle added').toBe(true)\n",
      "'toggle added').toBe(true)\n  // a comment\n",
    )
    assert.notEqual(edited, KINDS_EVAL)
    await writeFile(join(p.dir, 'evals/kinds.eval.ts'), edited)
    const elsewhere = await runCli(p.dir, ['run', '-v'])
    assert.deepEqual(
      namedIn(remarksBlock(elsewhere.stdout)),
      ['adds dark mode'],
      "a model remark's id is its quote; no-baseline's is the eval's source, which changed",
    )
  })
})

describe('no-baseline', () => {
  const darkMode = (
    options: string,
  ) => `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const dark = defineEnvironment('dark', { files: { 'dark.css': 'body {}\\n' } })
void plain
void dark
evaluate('adds dark mode', ${options}, async (c) => {
  await c.send('Add a dark mode toggle to the settings page.')
  expect(true, 'toggle added').toBe(true)
})
`

  test('raised when the classification names a change and nothing compares it', async () => {
    const p = await modelProject('remarks-nb-at', darkMode('{}'))
    const r = await runCli(p.dir, ['run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(
      remarksBlock(r.stdout)?.split('\n').slice(0, 3).join('\n'),
      [
        'Remarks:',
        "  adds dark mode: It's about dark mode, but nothing runs it without dark mode, so the result can't show what dark mode changes.",
        '    fix  evals/kinds.eval.ts:6  add compare: { baseline: <an environment without dark mode>, variants: [<one with it>] }',
      ].join('\n'),
    )
  })

  test('canary: a compare, a profile with limit.compare: false, or no change raises none', async () => {
    const compared = await modelProject(
      'remarks-nb-compare',
      darkMode('{ compare: { baseline: plain, variants: [dark] } }'),
    )
    const c = await runCli(compared.dir, ['run'])
    assert.equal(c.code, 0, c.stdout + c.stderr)
    assert.ok(!insightsOf(compared.dir)?.remarks.some((r) => r.kind === 'no-baseline'))

    const limited = await modelProject(
      'remarks-nb-profile',
      darkMode('{ compare: { baseline: plain, variants: [dark] } }'),
      `profiles: { quick: { limit: { compare: false } } },`,
    )
    const l = await runCli(limited.dir, ['run', '--profile', 'quick'])
    assert.equal(l.code, 0, l.stdout + l.stderr)
    assert.ok(!insightsOf(limited.dir)?.remarks.some((r) => r.kind === 'no-baseline'))

    const unnamed = await modelProject(
      'remarks-nb-nochange',
      darkMode('{}').replace("'adds dark mode'", "'adds a dark toggle'"),
    )
    const u = await runCli(unnamed.dir, ['run'])
    assert.equal(u.code, 0, u.stdout + u.stderr)
    assert.doesNotMatch(u.stdout, /Remarks:/)
  })
})

describe('the eval rubric', () => {
  const source = readFileSync(
    new URL('../../../skills/eval-rubric/SKILL.md', import.meta.url),
    'utf8',
  )

  test('has one section per remark kind, and none for anything else', () => {
    const sections = rubricKinds(source)
    assert.deepEqual([...sections].sort(), Object.keys(REMARK_KINDS).sort())
    assert.equal(new Set(sections).size, sections.length, 'one section each')
  })

  test('ships beside dist as the repository has it, and its hash is in the prompt version', () => {
    assert.equal(rubric(), source, 'pnpm build copies skills/eval-rubric')
    assert.match(insightsPromptVersion(), new RegExp(`-${rubricHash()}$`))
    assert.deepEqual(rubricKinds(modelRubric(MODEL_REMARK_KINDS)), [...MODEL_REMARK_KINDS])
    assert.deepEqual([...MODEL_REMARK_KINDS].sort(), [...MODEL_KINDS].sort())
  })
})

describe('the model remark gates', () => {
  const FILE = 'evals/a.eval.ts'
  const BODY = [
    "import { evaluate, expect } from 'reeval'",
    '',
    "evaluate('other', async (c) => {",
    "  await c.send('Write it.')",
    '})',
    '',
    "evaluate('answers kindly', async (c) => {",
    "  await c.send('Thank the user.')",
    "  expect(await c.judge('Is the answer okay?')).toPass()",
    '})',
    '',
  ].join('\n')
  const shown = (body: string) =>
    body
      .split('\n')
      .slice(6, 10)
      .map((l, i) => `L${i + 7} ${l}`)
  const gate = (
    remarks: Array<Partial<Parameters<typeof gateRemarks>[0][number]>>,
    { body = BODY, now = body as string | null, entries = 1 } = {},
  ) =>
    gateRemarks(
      remarks.map((r) => ({
        kind: 'judge-too-loose',
        text: 'The judge asks whether the answer is okay, which any reply passes.',
        source: { at: 'L9', quote: 'Is the answer okay?' },
        evidence: [],
        fix: null,
        ...r,
      })),
      {
        input: {
          call: 'insights',
          eval: { path: `${FILE} › answers kindly`, name: 'answers kindly', file: FILE },
          source: { file: FILE, lines: shown(body) },
        } as InsightInput,
        entries: Array.from(
          { length: entries },
          () => ({ sources: [{ path: FILE, sha256: sha256(body) }] }) as EvalEntry,
        ),
        files: new Map([[FILE, now]]),
      },
    )
  const kept = (...args: Parameters<typeof gate>) => gate(...args).kept.length
  const at = (a: string, quote = 'Is the answer okay?') => ({ source: { at: a, quote } })

  test('keeps a quote verbatim on its line, by L<n>, #L<n> or source:<file>#L<n>', () => {
    for (const a of ['L9', '#L9', `source:${FILE}#L9`]) {
      const out = gate([at(a)])
      assert.deepEqual(out.dropped, [], a)
      assert.deepEqual(out.kept[0]?.source, {
        at: `source:${FILE}#L9`,
        quote: 'Is the answer okay?',
      })
    }
    assert.equal(kept([at('L9', '  Is the answer okay?  ')]), 1, 'trailing whitespace is trimmed')
    const crlf = BODY.replace(/\n/g, '\r\n')
    assert.equal(kept([at('L9')], { body: crlf }), 1, 'a CRLF file')
  })

  test('canary: a kind the model may not raise is dropped', () => {
    for (const kind of [
      'flaky-check',
      'no-baseline',
      'too-few-tries',
      'Judge-Too-Loose',
      ' judge-too-loose',
      '',
    ]) {
      assert.equal(kept([{ kind }]), 0, JSON.stringify(kind))
    }
  })

  test('canary: a line that is not the quote’s, or not one the eval was shown, is dropped', () => {
    for (const a of [
      'L8',
      'L10',
      'L0',
      'L-9',
      'L9.0',
      'L99',
      'L',
      'source:L9',
      `source:${FILE}L9`,
    ]) {
      assert.equal(kept([at(a)]), 0, a)
    }
    assert.equal(kept([at('L4', "c.send('Write it.')")]), 0, "another eval's line")
    assert.equal(kept([at('L4', 'await c.send(')]), 0, "a quote another eval's line has too")
    for (const quote of ['', '   ', 'Is the answer okay?\n  })']) {
      assert.equal(kept([at('L9', quote)]), 0, JSON.stringify(quote))
    }
    assert.equal(kept([at('L9', '})')]), 0, 'a quote shorter than three characters')
  })

  test('canary: a file that changed, is missing or isn’t the eval’s is dropped', () => {
    assert.equal(kept([at('L9')], { now: `${BODY}// edited\n` }), 0)
    assert.equal(kept([at('L9')], { now: null }), 0)
    for (const path of ['evals/../evals/a.eval.ts', `/abs/${FILE}`, '../a.eval.ts', 'other.ts']) {
      assert.equal(kept([at(`source:${path}#L9`)]), 0, path)
    }
  })

  test('canary: one per kind, an eval the run recorded, and the sentence rules', () => {
    const two = gate([{}, at('L9', 'answer okay')])
    assert.equal(two.kept.length, 1)
    assert.match(two.dropped[0]?.reason ?? '', /second judge-too-loose/)
    assert.equal(kept([{}], { entries: 0 }), 0)
    assert.equal(kept([{ text: Array(26).fill('word').join(' ') }]), 0)
    assert.equal(kept([{ text: 'The judge passes any reply (F2).' }]), 0)
    assert.equal(kept([{ text: '   ' }]), 0)
  })
})
