import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { EvalEntry, RunRecord } from '../src/history/types.ts'
import { readRemarks } from '../src/remarks/files.ts'
import { defaultBranch } from '../src/remarks/index.ts'
import {
  type CheckWindow,
  deterministicRemarks,
  type RemarkContext,
  type Streak,
} from '../src/remarks/rules.ts'
import { REMARK_KINDS, type RunRemarks } from '../src/view/remarks.ts'
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
const compareEval = (runs: number, variant: number, base: number, name = 'skill helps') => `
import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\\n' } })
evaluate('${name}', { runs: ${runs}, compare: { baseline: plain, variants: [marked] } }, async (c) => {
  await c.send('go')
  const wins = c.attempt.cell.role === 'variant' ? ${variant} : ${base}
  expect(c.attempt.n <= wins, 'uses the marker').toBe(true)
})
`

/** Evals whose check fails on every try but the first. */
const coinEvals = (names: string[], runs = 3) =>
  `import { evaluate, expect } from 'reeval'
${names
  .map(
    (name) => `evaluate('${name}', { runs: ${runs} }, async (c) => {
  await c.send('go')
  expect(c.attempt.n, 'lands heads').toBe(1)
})`,
  )
  .join('\n')}
`

const CLEAN_EVAL = `import { evaluate, expect } from 'reeval'
evaluate('clean', { runs: 4 }, async (c) => {
  await c.send('go')
  expect(1, 'always one').toBe(1)
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

/** An eval of two turns on an environment whose MCP server `docs` runs `command`. */
const mcpEval = (name: string, server: string, command: string) => `
import { defineEnvironment, evaluate, expect } from 'reeval'
const docs = defineEnvironment('${name}-docs', ({ file, mcp }) => ({
  files: { 'server.mjs': file('../${server}') },
  mcp: { docs: mcp.stdio(${command}) },
}))
evaluate('${name}', { environment: docs }, async (c) => {
  await c.send('look it up')
  await c.send('and again')
  expect(true, 'answered').toBe(true)
})
`

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

/** The record cut to the eval named `name`. */
const only = (record: RunRecord, name: string): RunRecord => {
  const evals = record.evals.filter((e) => e.name === name)
  assert.equal(evals.length, 1, name)
  return { ...structuredClone(record), evals: structuredClone(evals) }
}

/** The newest scratch run's remarks, or the one `back` runs before it. */
const remarksOf = (dir: string, back = 0): RunRemarks | null => {
  const file = join(readRun(dir, { back }).dir, 'remarks.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

const remarksBlock = (stdout: string) => {
  const at = stdout.indexOf('\nRemarks:')
  return at < 0 ? null : stdout.slice(at + 1)
}

/** The evals a remarks block names, in order. */
const namedIn = (block: string | null) =>
  [...(block ?? '').matchAll(/^ {2}(\S[^:]*):/gm)].map((m) => m[1])

/** One fake run of an eval per rule, for the rules to read with a stubbed history. */
let rulesRecord: Promise<RunRecord> | undefined
const rules = () => {
  rulesRecord ??= (async () => {
    const p = await project('remarks-rules', {
      'reeval.config.ts': fakeConfig(),
      'evals/tft-at.eval.ts': compareEval(2, 2, 1, 'tft at'),
      'evals/tft-gap.eval.ts': compareEval(3, 2, 1, 'tft gap'),
      'evals/tft-enough.eval.ts': compareEval(4, 4, 0, 'tft enough'),
      'evals/clean.eval.ts': CLEAN_EVAL,
      'evals/coin.eval.ts': coinEvals(['coin'], 2),
      'evals/db.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('migrates', async (c) => {
  await c.send('go')
  expect('psql: Network is unreachable', 'migrated').toBe('ok')
})
`,
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
    const r = await runCli(p.dir, ['run'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    return readRun(p.dir).run
  })()
  return rulesRecord
}

describe('remark thresholds', () => {
  test('too-few-tries: a gap of half the tries with fewer than 4 a side, not under it', async () => {
    const record = await rules()
    const [remark] = raise(only(record, 'tft at'), NO_HISTORY)
    assert.equal(remark?.kind, 'too-few-tries')
    assert.equal(remark?.severity, 'suggestion')
    assert.equal(
      remark?.text,
      'Marked passed 2 of 2 tries and plain 1 of 2: too few tries to tell whether the difference holds.',
    )
    assert.equal(remark?.fix?.edit, 'set runs: 4 or more, so each side counts at least 4 tries')
    assert.deepEqual(
      kinds(only(record, 'tft gap'), NO_HISTORY),
      [],
      'a gap of a third is under the threshold',
    )
    assert.deepEqual(kinds(only(record, 'tft enough'), NO_HISTORY), [], '4 tries a side can tell')
  })

  test('check-never-fails: 5 clean recorded runs and 20 tries, not 4 runs or 19 tries', async () => {
    const record = only(await rules(), 'clean')
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
    const record = only(await rules(), 'coin')
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
    const record = only(await rules(), 'migrates')
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
    const record = only(await rules(), 'serves')
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

  test('snapshot-too-large: an attempt over the cap took no snapshot, not one taken or off', async () => {
    const record = only(await rules(), 'serves')
    const taken = (
      form: 'dir' | 'tar.gz',
      ...causes: Array<'size' | 'error' | null | undefined>
    ) => {
      const copy = structuredClone(record)
      for (const [i, a] of (copy.evals[0]?.attempts ?? []).entries()) {
        const cause = causes[i]
        if (cause === undefined) delete a.snapshots
        else {
          a.snapshots = [
            {
              name: 'final',
              form,
              path: cause ? null : 'x/1/snapshots/final',
              bytes: 0,
              files: 0,
              excluded: [],
              masked: [],
              dropped: [],
              skipped: cause && { cause, message: `the workspace is 60.0 MB (${cause})` },
            },
          ]
        }
      }
      return copy
    }
    assert.deepEqual(kinds(taken('dir', null), NO_HISTORY), [], 'taken')
    assert.deepEqual(kinds(taken('dir', undefined), NO_HISTORY), [], 'snapshot: false')
    assert.deepEqual(kinds(taken('dir', 'error'), NO_HISTORY), [], 'an archive the sandbox failed')
    const [remark] = raise(taken('dir', 'size'), NO_HISTORY)
    assert.equal(remark?.kind, 'snapshot-too-large')
    assert.equal(remark?.severity, 'concern')
    assert.equal(remark?.text, 'reeval took no final snapshot: the workspace is 60.0 MB (size).')
    assert.match(
      remark?.fix.edit ?? '',
      /, set snapshot: \{ compress: true \} for the larger cap, or set snapshot: false on the eval$/,
    )
    assert.equal(remark?.evidence.length, 1)
    const [packed] = raise(taken('tar.gz', 'size'), NO_HISTORY)
    assert.doesNotMatch(packed?.fix.edit ?? '', /compress/)
  })
})

describe('remarks in reeval run', () => {
  test('a suggestion waits for -v; the cap holds back a concern for the next -v run; each prints once', async () => {
    const coins = ['coin one', 'coin two', 'coin three', 'coin four']
    const p = await project('remarks-print', {
      'reeval.config.ts': fakeConfig(),
      'evals/skill.eval.ts': compareEval(2, 2, 0),
      'evals/well.eval.ts': compareEval(4, 4, 0, 'well written'),
      'evals/coin.eval.ts': coinEvals(coins),
    })
    const blocks: Array<string | null> = []
    const run = async (...args: string[]) => {
      const r = await runCli(p.dir, ['run', ...args])
      assert.equal(r.code, 1, r.stdout + r.stderr)
      blocks.push(remarksBlock(r.stdout))
      return blocks.at(-1) ?? null
    }
    const tftOf = (doc: RunRemarks | null) => doc?.remarks.find((r) => r.kind === 'too-few-tries')

    assert.equal(await run(), null, 'suggestions print under -v only')
    const quiet = remarksOf(p.dir)
    assert.deepEqual(
      quiet?.remarks.map((r) => [r.kind, r.firstSeenRun]),
      [['too-few-tries', quiet?.runId]],
    )
    assert.doesNotMatch(readRun(p.dir).read('summary.md'), /Remarks:/)

    const later = await run('-v')
    assert.deepEqual(namedIn(later), ['skill helps'], 'a suggestion a run without -v hid prints')
    assert.match(later ?? '', /too few tries/)

    const capped = (await run()) ?? ''
    assert.match(capped, /\+1 more \(-v\)/)
    assert.equal(namedIn(capped).length, 3)
    assert.ok(namedIn(capped).every((n) => coins.includes(n as string)))
    const marks = remarksOf(p.dir)
      ?.remarks.filter((r) => r.kind === 'flaky-check')
      .map((r) => r.printed)
    assert.deepEqual(marks, [true, true, true, false])
    assert.deepEqual(
      [
        tftOf(quiet)?.printed,
        tftOf(remarksOf(p.dir, 1))?.printed,
        tftOf(remarksOf(p.dir))?.printed,
      ],
      [false, true, false],
    )
    assert.equal(tftOf(remarksOf(p.dir, 1))?.firstSeenRun, tftOf(remarksOf(p.dir))?.firstSeenRun)

    assert.deepEqual(
      namedIn(await run('-v')),
      coins.filter((c) => !namedIn(capped).includes(c)),
      'only the concern the cap hid',
    )
    assert.equal(await run('-v'), null, 'every remark has printed')
    for (const block of blocks) assert.doesNotMatch(block ?? '', /well written/)
  })

  test('a fix points at its line, a family at its name template; an edit re-arms only its eval', async () => {
    const p = await project('remarks-once', {
      'reeval.config.ts': fakeConfig(),
      'evals/skill.eval.ts': compareEval(2, 2, 0),
      'evals/fam.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const plain = defineEnvironment('plain', {})
const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\\n' } })
evaluate.each([{ id: 'a' }, { id: 'b' }])(
  'fixes $id',
  { runs: 2, compare: { baseline: plain, variants: [marked] } },
  async (c) => {
    await c.send('go')
    expect(c.attempt.cell.role === 'variant', 'uses the marker').toBe(true)
  },
)
`,
    })
    const first = remarksBlock((await runCli(p.dir, ['run', '-v'])).stdout) ?? ''
    assert.ok(
      first.includes(
        [
          '  skill helps: Marked passed 2 of 2 tries and plain 0 of 2: too few tries to tell whether the difference holds.',
          '    fix  evals/skill.eval.ts:5  set runs: 4 or more, so each side counts at least 4 tries',
        ].join('\n'),
      ),
      first,
    )
    assert.match(first, /^ {2}fixes \$id: Marked passed .*\n {4}fix {2}evals\/fam\.eval\.ts:5 /m)
    const firstRun = readRun(p.dir).run.runId
    const second = await runCli(p.dir, ['run', '-v'])
    assert.equal(remarksBlock(second.stdout), null, 'printed once per eval version')
    assert.ok(remarksOf(p.dir)?.remarks.every((r) => r.firstSeenRun === firstRun))

    await writeFile(
      join(p.dir, 'evals/skill.eval.ts'),
      compareEval(2, 2, 0).replace("'go'", "'go now'"),
    )
    const edited = remarksBlock((await runCli(p.dir, ['run', '-v'])).stdout)
    assert.deepEqual(namedIn(edited), ['skill helps'], 'an edited eval re-arms its own remark')
  })

  test("an older reeval's remark, with no printed, counts as printed in the run that raised it", async () => {
    const p = await project('remarks-unmarked', {
      'reeval.config.ts': fakeConfig(),
      'evals/skill.eval.ts': compareEval(2, 2, 0),
    })
    await runCli(p.dir, ['run'])
    const file = join(readRun(p.dir).dir, 'remarks.json')
    const doc = JSON.parse(readFileSync(file, 'utf8')) as RunRemarks
    for (const r of doc.remarks) delete r.printed
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`)
    const later = await runCli(p.dir, ['run', '-v'])
    assert.equal(later.code, 0, later.stderr)
    assert.equal(remarksBlock(later.stdout), null)
  })

  test('slow-mcp-start: 2000 ms or no answer, printed in every run; not 1999 ms', async () => {
    const p = await project('remarks-mcp', {
      'reeval.config.ts': fakeConfig({
        harness: `{ script: [[{ mcp: 'docs/lookup' }, { reply: 'one' }], [{ mcp: 'docs/lookup' }, { reply: 'two' }]] }`,
      }),
      'slow.mjs': slowServer(2000),
      'fast.mjs': slowServer(0),
      'evals/slow.eval.ts': mcpEval('slow', 'slow.mjs', `'node', ['server.mjs']`),
      'evals/fast.eval.ts': mcpEval('fast', 'fast.mjs', `'node', ['server.mjs']`),
      'evals/dead.eval.ts': mcpEval('dead', 'fast.mjs', `'node', ['-e', 'process.exit(1)']`),
    })
    for (let i = 0; i < 2; i++) {
      const r = await runCli(p.dir, ['run'])
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const block = remarksBlock(r.stdout) ?? ''
      assert.deepEqual(namedIn(block).sort(), ['dead', 'slow'], 'a fast server raises none')
      assert.match(
        block,
        /^ {2}slow: MCP server docs took 2(\.\d)?s to start on each of 2 turns\.\n {4}fix {2}evals\/slow\.eval\.ts:5 {2}install what docs needs in the image/m,
      )
      assert.match(
        block,
        /^ {2}dead: MCP server docs never answered within the start-up timeout on each of 2 turns\.\n {4}fix {2}\S+ {2}run docs's command in the sandbox with c\.exec/m,
      )
    }
    const shown = await runCli(p.dir, ['show'])
    assert.match(shown.stdout, /Remarks:\n(.*\n)* {2}slow: MCP server docs took/)

    const record = only(readRun(p.dir).run, 'fast')
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

  test('flaky-check after 2 mixed runs and 6 tries; check-never-fails after 5 recorded runs on the default branch', async () => {
    const p = await project('remarks-history', {
      '.gitignore': '.reeval/\nnode_modules/\nsandboxes/\n',
      'reeval.config.ts': fakeConfig(),
      'evals/clean.eval.ts': CLEAN_EVAL,
      // `steady` shares the label, so the fix must point into `coin`'s own body.
      'evals/coin.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('steady', { runs: 3 }, async (c) => {
  await c.send('go')
  expect(1, 'lands heads').toBe(1)
})
evaluate('coin', { runs: 3 }, async (c) => {
  await c.send('go')
  expect(c.attempt.n, 'lands heads').toBe(1)
})
`,
    })
    sh(p.dir, 'init', '-q', '-b', 'main')
    sh(p.dir, 'add', '-A')
    sh(p.dir, 'commit', '-q', '-m', 'init')
    const history = (runId: string, file: string) => join(p.dir, 'evals/.history', runId, file)
    const blocks: Array<string | null> = []
    for (let i = 0; i < 6; i++) {
      const r = await runCli(p.dir, ['run', '--record', '-v'])
      assert.equal(r.code, 1, 'a remark never changes the exit code')
      blocks.push(remarksBlock(r.stdout))
      if (i === 0) {
        const runId = recordedRuns(p.dir).at(-1) as string
        assert.ok(!existsSync(history(runId, 'remarks.json')), 'a run with none writes no file')
      }
      if (i === 2) {
        assert.equal(
          blocks[2]?.split('\n').slice(0, 3).join('\n'),
          [
            'Remarks:',
            '  coin: "lands heads" passed 2 of 6 tries over 2 runs with nothing changed, so one try can pass or fail it.',
            '    fix  evals/coin.eval.ts:8  make "lands heads" check something every good try does, or raise runs so one try doesn\'t decide it',
          ].join('\n'),
        )
        const summary = readFileSync(history(recordedRuns(p.dir).at(-1) as string, 'summary.md'))
        assert.match(summary.toString(), /Remarks:\n {2}coin: "lands heads"/)
      }
    }
    assert.deepEqual(
      blocks.map((b) => namedIn(b)),
      [[], [], ['coin'], [], [], ['clean']],
      `run k has k-1 runs before it; each prints once\n${blocks.join('\n')}`,
    )
    assert.equal(
      blocks[5]?.split('\n').slice(0, 3).join('\n'),
      [
        'Remarks:',
        '  clean: "always one" passed every try in the last 5 recorded runs (20 tries), so it never tells a good result from a bad one.',
        '    fix  evals/clean.eval.ts:4  make "always one" strict enough to fail on a wrong result, or remove it',
      ].join('\n'),
    )
    const recorded = recordedRuns(p.dir).at(-1) as string
    const doc = JSON.parse(readFileSync(history(recorded, 'remarks.json'), 'utf8')) as RunRemarks
    assert.deepEqual(
      doc.remarks.filter((r) => r.kind === 'check-never-fails').map((r) => r.firstSeenRun),
      [recorded],
    )
    assert.doesNotMatch(
      readFileSync(history(recorded, 'summary.md'), 'utf8'),
      /Remarks:/,
      'summary.md prints concerns only',
    )
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
})

test('the eval rubric has one section per remark kind, and none for anything else', () => {
  const source = readFileSync(
    new URL('../../../skills/eval-rubric/SKILL.md', import.meta.url),
    'utf8',
  )
  const sections = [...source.matchAll(/^## `([a-z-]+)`\s*$/gm)].map((m) => m[1])
  assert.deepEqual([...sections].sort(), Object.keys(REMARK_KINDS).sort())
  assert.equal(new Set(sections).size, sections.length, 'one section each')
})

test('a remarks file from a newer reeval, or not JSON, is skipped with one warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-remarks-'))
  const doc: RunRemarks = {
    kind: 'reeval-remarks',
    schemaVersion: 1,
    runId: 'r1',
    createdAt: '2026-10-26T00:00:00.000Z',
    remarks: [],
  }
  const file = (name: string, text: string) => {
    const path = join(dir, name)
    return writeFile(path, text).then(() => path)
  }
  const warnings: string[] = []
  const write = process.stderr.write
  process.stderr.write = ((chunk: string) => warnings.push(String(chunk)) > 0) as typeof write
  try {
    assert.deepEqual(await readRemarks(await file('ok.json', JSON.stringify(doc))), doc)
    assert.equal(await readRemarks(join(dir, 'missing.json')), null)
    const newer = await file('newer.json', JSON.stringify({ ...doc, schemaVersion: 2 }))
    assert.equal(await readRemarks(newer), null)
    assert.equal(await readRemarks(newer), null)
    const conflict = await file('conflict.json', '<<<<<<< HEAD\n{}')
    assert.equal(await readRemarks(conflict), null)
  } finally {
    process.stderr.write = write
  }
  assert.equal(warnings.length, 2, warnings.join(''))
  assert.match(warnings[0] ?? '', /newer\.json: .*written by a newer reeval/)
  assert.match(warnings[1] ?? '', /conflict\.json: it isn't valid JSON/)
})
