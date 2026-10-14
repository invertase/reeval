import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, sep } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  fakeConfig,
  liveSandboxes,
  noSignals,
  pkgRoot,
  project,
  readRun,
  runCli,
} from './helpers.ts'

const math = (value: number) => `
import { evaluate, expect } from 'reeval'
evaluate('math', async () => expect(1).toBe(${value}))
`

describe('engine', () => {
  test('a passing eval exits 0 with no Vitest branding', async () => {
    const p = await project('pass', {
      'reeval.config.ts': fakeConfig(),
      'evals/math.eval.ts': math(1),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /✓ evals\/math\.eval\.ts › math/)
    assert.match(r.stdout, /Evals {2}1 passed \(1\)/)
    assert.match(
      r.stdout,
      /Results {2}\.reeval\/runs\/\d{8}T\d{6}Z_[0-9a-z]+_[a-z0-9-]+_[0-9a-z]{4}\/summary\.md/,
    )
    for (const leak of [/vitest/i, /RUN v/, /testTimeout/]) {
      assert.doesNotMatch(r.stdout + r.stderr, leak)
    }
    const { run } = readRun(p.dir)
    assert.equal(run.schemaVersion, 1)
    assert.equal(run.status, 'complete')
    assert.deepEqual(run.summary, {
      evals: 1,
      attempts: 1,
      pass: 1,
      fail: 0,
      notGated: 0,
      infraError: 0,
      skipped: 0,
    })
    assert.equal(run.evals[0]?.id, 'evals/math.eval.ts › math')
    assert.ok(!existsSync(join(p.dir, '.reeval/attachments')), 'no copies of the records')
    assert.ok(!existsSync(join(p.dir, '.reeval/staging', run.runId)), 'staging cleaned up')
  })

  test('a failing assertion exits 1', async () => {
    const p = await project('fail', {
      'reeval.config.ts': fakeConfig(),
      'evals/math.eval.ts': math(2),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /✗ evals\/math\.eval\.ts › math/)
    assert.doesNotMatch(r.stdout + r.stderr, /vitest/i)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.outcome, 'fail')
    assert.equal(e?.error?.kind, 'assertion')
    assert.match(e?.error?.message ?? '', /expected 1 to be 2/)
  })

  test('filters match paths, then eval names', async () => {
    const p = await project('filter', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': math(1),
      'evals/b.eval.ts': `import { evaluate } from 'reeval'\nevaluate('named thing', async () => {})\n`,
    })
    const byPath = await runCli(p.dir, ['run', 'a.eval'])
    assert.equal(byPath.code, 0)
    assert.match(byPath.stdout, /a\.eval\.ts › math/)
    assert.doesNotMatch(byPath.stdout, /named thing/)

    const byName = await runCli(p.dir, ['run', 'named thing'])
    assert.equal(byName.code, 0)
    assert.match(byName.stdout, /b\.eval\.ts › named thing/)
    assert.doesNotMatch(byName.stdout, /› math/)

    const { runId } = readRun(p.dir).run
    const none = await runCli(p.dir, ['run', 'nope'])
    assert.equal(none.code, 2, none.stdout + none.stderr)
    assert.match(none.stderr, /No evals matched evals\/\*\*\/\*\.eval\.ts with filter "nope"/)
    assert.equal(readRun(p.dir).run.runId, runId, 'no empty run written')
    assert.deepEqual(readdirSync(join(p.dir, '.reeval/staging')), [], 'no staging left behind')
  })

  test('a path filter and a cell filter together run only that cell of that file', async () => {
    const p = await project('mixed-filter', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: [fakeHarness({ id: 'left' }), fakeHarness({ id: 'right' })],
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
})
`,
      'evals/scaffold.eval.ts': math(1),
      'evals/other.eval.ts': math(1),
    })
    const r = await runCli(p.dir, ['run', 'scaffold', 'right/', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, / · harness right · /, 'the header names only the harness that runs')
    const { evals } = readRun(p.dir)
    assert.deepEqual(
      evals.map((e) => [e.id, e.cells.map((c) => c.key)]),
      [['evals/scaffold.eval.ts › math', ['right/fake/fake']]],
    )
  })

  test('eval files that declare no evals exit 2 instead of writing an empty run', async () => {
    const p = await project('no-evals', {
      'reeval.config.ts': fakeConfig(),
      'evals/empty.eval.ts': `import { evaluate } from 'reeval'\nvoid evaluate\n`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /No evals matched evals\/\*\*\/\*\.eval\.ts/)
    assert.ok(!existsSync(join(p.dir, '.reeval/runs')), 'no run written')
  })

  for (const [what, body, message] of [
    ['throws', `throw new Error('boom at import')`, /evals\/bad\.eval\.ts: boom at import/],
    ['imports a missing file', `import './nope.ts'`, /evals\/bad\.eval\.ts: .*nope\.ts/],
    [
      'has a syntax error',
      `evaluate('f' async () => {})`,
      /evals\/bad\.eval\.ts: Unexpected token, expected "," \(evals\/bad\.eval\.ts:2:14\)\n.*\n.*\n {3}\| {14}\^/,
    ],
  ] as const) {
    test(`an eval file that ${what} exits 2 naming it, next to a good file`, async () => {
      const p = await project('bad-eval-file', {
        'reeval.config.ts': fakeConfig(),
        'evals/good.eval.ts': `import { evaluate } from 'reeval'\nevaluate('good', async () => {})\n`,
        'evals/bad.eval.ts': `import { evaluate } from 'reeval'\n${body}\nevaluate('bad', async () => {})\n`,
      })
      for (const args of [['run'], ['run', '--dry-run']]) {
        const r = await runCli(p.dir, args)
        assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
        assert.match(r.stderr, message)
        assert.ok(!existsSync(join(p.dir, '.reeval/runs')), 'no run written')
      }
    })
  }

  test('a tsconfig that extends a missing file fails every eval file loudly, once', async () => {
    const p = await project('bad-tsconfig', {
      'reeval.config.ts': fakeConfig(),
      'tsconfig.json': '{ "extends": "../../tsconfig.base.json" }',
      'evals/a.eval.ts': `import { evaluate } from 'reeval'\nevaluate('a', async () => {})\n`,
      'evals/b.eval.ts': `import { evaluate } from 'reeval'\nevaluate('b', async () => {})\n`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /2 eval files failed to load:\nevals\/a\.eval\.ts, evals\/b\.eval\.ts: [\s\S]*Failed to load tsconfig '\.\.\/\.\.\/tsconfig\.base\.json'/,
    )
    assert.equal(r.stderr.includes('\u001b['), false, 'no terminal colours')
  })

  test('groups nest, cascade options and appear in ids and result.json', async () => {
    const p = await project('groups', {
      'reeval.config.ts': fakeConfig(),
      'evals/g.eval.ts': `import { evaluate, expect, group } from 'reeval'
group('outer', { timeout: '1s' }, () => {
  group('inner', () => {
    evaluate('slow', async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve))
    })
  })
  evaluate('fast', async () => expect(1).toBe(1))
})
evaluate('top level', async () => {})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /✗ evals\/g\.eval\.ts › outer › inner › slow/)
    assert.match(r.stdout, /✓ evals\/g\.eval\.ts › outer › fast/)
    const evals = readRun(p.dir).evals
    assert.deepEqual(
      evals.map((e) => [e.group, e.name, e.outcome]),
      [
        [['outer', 'inner'], 'slow', 'fail'],
        [['outer'], 'fast', 'pass'],
        [[], 'top level', 'pass'],
      ],
    )
    assert.equal(evals[0]?.error?.kind, 'timeout')

    const filtered = await runCli(p.dir, ['run', 'outer › fast'])
    assert.equal(filtered.code, 0, filtered.stdout + filtered.stderr)
    assert.deepEqual(
      readRun(p.dir).evals.map((e) => [e.name, e.outcome]),
      [['fast', 'pass']],
    )

    const { runId } = readRun(p.dir).run
    const spaced = await runCli(p.dir, ['run', 'outer fast'])
    assert.equal(spaced.code, 2, spaced.stdout + spaced.stderr)
    assert.match(
      spaced.stderr,
      /No evals matched evals\/\*\*\/\*\.eval\.ts with filter "outer fast"/,
    )
    assert.equal(readRun(p.dir).run.runId, runId, 'no run written')
  })

  test('skip is reported as skipped', async () => {
    const p = await project('skip', {
      'reeval.config.ts': fakeConfig(),
      'evals/s.eval.ts': `import { evaluate } from 'reeval'
evaluate('runs', async () => {})
evaluate.skip('skipped', async () => { throw new Error('nope') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0)
    assert.deepEqual(readRun(p.dir).run.summary, {
      evals: 2,
      attempts: 2,
      pass: 1,
      fail: 0,
      notGated: 0,
      infraError: 0,
      skipped: 1,
    })
  })

  test("a skipped group's evals, nested ones too, are recorded as skipped and never run", async () => {
    const p = await project('group-skip', {
      'reeval.config.ts': fakeConfig(),
      'evals/g.eval.ts': `import { evaluate, group } from 'reeval'
group.skip('parked', () => {
  evaluate('inside', async () => { throw new Error('the body ran') })
  group('nested', () => {
    evaluate('deeper', async () => { throw new Error('the body ran') })
  })
})
group.todo('someday')
evaluate('kept', async () => {})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run } = readRun(p.dir)
    assert.deepEqual(
      run.evals.map((e) => [e.id, e.outcome]),
      [
        ['evals/g.eval.ts › parked › inside', 'skipped'],
        ['evals/g.eval.ts › parked › nested › deeper', 'skipped'],
        ['evals/g.eval.ts › someday', 'skipped'],
        ['evals/g.eval.ts › kept', 'pass'],
      ],
    )
    assert.equal(run.summary.skipped, 3)
  })

  test('group.todo shows as todo, like evaluate.todo: the plan, the summary and the record', async () => {
    const p = await project('group-todo', {
      'reeval.config.ts': fakeConfig(),
      'evals/g.eval.ts': `import { evaluate, group } from 'reeval'
evaluate('kept', async () => {})
evaluate.todo('later')
group.todo('someday')
group('area', () => {
  group.todo('nested someday')
})
`,
    })
    const todos = [
      'evals/g.eval.ts › later',
      'evals/g.eval.ts › someday',
      'evals/g.eval.ts › area › nested someday',
    ]

    const json = await runCli(p.dir, ['run', '--dry-run', '--json'])
    assert.equal(json.code, 0, json.stdout + json.stderr)
    assert.deepEqual(
      JSON.parse(json.stdout).excluded,
      todos.map((id) => ({ id, mode: 'todo' })),
    )
    const text = await runCli(p.dir, ['run', '--dry-run'])
    assert.equal(text.code, 0, text.stdout + text.stderr)
    for (const id of todos) assert.match(text.stdout, new RegExp(`^${id} .* todo$`, 'm'), id)
    assert.doesNotMatch(text.stdout, /^evals\/g\.eval\.ts › kept .* todo$/m, 'canary: kept runs')

    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const summary = r.stdout.slice(r.stdout.indexOf('\nSummary'))
    for (const name of ['later', 'someday', 'nested someday'])
      assert.match(summary, new RegExp(`↓ ${name} +todo$`, 'm'), name)
    const { run, read } = readRun(p.dir)
    assert.deepEqual(
      run.evals.map((e) => [e.id, e.outcome, e.todo]),
      [
        ['evals/g.eval.ts › kept', 'pass', false],
        ['evals/g.eval.ts › later', 'skipped', true],
        ['evals/g.eval.ts › someday', 'skipped', true],
        ['evals/g.eval.ts › area › nested someday', 'skipped', true],
      ],
    )
    assert.match(read('summary.md'), /\| ↓ \| evals\/g\.eval\.ts › someday \| todo \|/)
  })

  test('.env.local wins over .env, the shell wins over both, and evals see them', async () => {
    const p = await project('dotenv', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
const id = (name: string) => process.env[name] ?? 'unset'
export default defineConfig({
  harness: [fakeHarness({ id: id('REEVAL_T_BOTH') }), fakeHarness({ id: id('REEVAL_T_ENV') }), fakeHarness({ id: id('REEVAL_T_SHELL') })],
  environment: defineEnvironment('fake', { sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }) }),
})
`,
      '.env': 'REEVAL_T_BOTH=from-env\nREEVAL_T_ENV=only-env\nREEVAL_T_SHELL=from-env\n',
      '.env.local': 'REEVAL_T_BOTH=from-local\nREEVAL_T_SHELL=from-local\n',
      'evals/sees.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('sees', async () => expect(process.env.REEVAL_T_BOTH).toBe('from-local'))
`,
      'evals/canary.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('canary', async () => expect(process.env.REEVAL_T_BOTH).toBe('from-env'))
`,
    })
    const env = { REEVAL_T_SHELL: 'from-shell' }
    const plan = await runCli(p.dir, ['run', '--dry-run', '--json'], { env })
    assert.equal(plan.code, 0, plan.stdout + plan.stderr)
    const cells = JSON.parse(plan.stdout).evals[0].cells.map((c: { key: string }) => c.key)
    assert.deepEqual(cells, ['from-local/fake/fake', 'only-env/fake/fake', 'from-shell/fake/fake'])

    await writeFile(join(p.dir, 'evals/.env.local'), 'REEVAL_T_ENV=from-cwd\n')
    const fromSub = await runCli(
      join(p.dir, 'evals'),
      ['run', '--config', '../reeval.config.ts', '--dry-run', '--json'],
      { env },
    )
    assert.equal(fromSub.code, 0, fromSub.stdout + fromSub.stderr)
    assert.deepEqual(
      JSON.parse(fromSub.stdout).evals[0].cells.map((c: { key: string }) => c.key),
      cells,
      "run from a subdirectory, the env files still come from the config's directory",
    )

    const sees = await runCli(p.dir, ['run', 'sees.eval'], { env })
    assert.equal(sees.code, 0, sees.stdout + sees.stderr)
    const canary = await runCli(p.dir, ['run', 'canary.eval'], { env })
    assert.equal(canary.code, 1, canary.stdout + canary.stderr)
    assert.match(
      readRun(p.dir).evals[0]?.error?.message ?? '',
      /expected 'from-local' to be 'from-env'/,
    )
  })

  test('reeval that runs out of things to wait on, unfinished, exits 3 and says so, never 0', async () => {
    // A config that awaits a promise nothing will settle: Node's loop empties with the run unfinished.
    const p = await project('drained', {
      'reeval.config.ts': `${fakeConfig()}\nawait new Promise(() => {})\n`,
      'evals/a.eval.ts': math(1),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(r.stderr, /reeval: stopped before it finished: nothing was left for it to wait on/)
  })

  test('usage errors exit 2', async () => {
    const empty = await project('empty', { 'reeval.config.ts': fakeConfig() })
    const none = await runCli(empty.dir)
    assert.equal(none.code, 2)
    assert.match(
      none.stderr,
      /No eval files match evals\/\*\*\/\*\.eval\.ts \(config\.include\) in \S*empty\S*\. Name eval files to match it, or set include in reeval\.config\.ts\./,
    )

    assert.equal((await runCli(empty.dir, ['run', '--config', 'missing.ts'])).code, 2)
    assert.equal((await runCli(empty.dir, ['bogus'])).code, 2)
    assert.equal((await runCli(empty.dir, ['--help'])).code, 0)

    const real = await project('creds', {
      'reeval.config.ts': `import { defineConfig, defineEnvironment } from 'reeval'\nexport default defineConfig({})\n`,
      'evals/math.eval.ts': math(1),
    })
    const creds = await runCli(real.dir)
    assert.equal(creds.code, 2)
    assert.match(creds.stderr, /Missing credentials: CURSOR_API_KEY/)

    const wrapped = await runCli(real.dir, ['run'], {
      env: { CURSOR_API_KEY: 'crsr_0123456789\n   │ abcdef' },
    })
    assert.equal(wrapped.code, 2)
    assert.match(
      wrapped.stderr,
      /Credentials with whitespace or a line break in them: CURSOR_API_KEY \(character 16\)\. A key copied from a wrapped terminal line picks these up; set it again as one line\./,
    )
    assert.doesNotMatch(wrapped.stderr, /abcdef/, 'never prints the value')
  })

  test("a project's own vitest, for its own tests, coexists without a warning", async () => {
    const p = await project('coexist', {
      'reeval.config.ts': fakeConfig(),
      'evals/math.eval.ts': math(1),
      'node_modules/vitest/package.json': '{ "name": "vitest", "version": "3.2.0" }',
      'vitest.config.ts': 'export default {}\n',
      'src/sum.test.ts': "throw new Error('reeval must not run the project tests')\n",
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stderr, /warning/)
    assert.deepEqual(
      readRun(p.dir).evals.map((e) => e.id),
      ['evals/math.eval.ts › math'],
    )
  })

  test('eval files mix TypeScript, ESM, CommonJS and JSON, with extensionless, circular imports and top-level await', async () => {
    const p = await project('module-mix', {
      'reeval.config.ts': fakeConfig(),
      'evals/mix.eval.ts': `import { evaluate, expect } from 'reeval'
import { a, fromB } from './circ-a'
import cjs, { named } from './lib.cjs'
import data from './data.json'
import { m } from './mod.mts'
enum Color { Red = 1 }
const waited = await new Promise<string>((r) => setTimeout(() => r('tla'), 5))
evaluate('mixed', async () => {
  expect({ a, b: fromB(), cjs: cjs.kind, named, data, m, color: Color.Red, waited }).toEqual({
    a: 'A', b: 'B sees A', cjs: 'cjs', named: 'N', data: { k: 1 }, m: 'mts', color: 1, waited: 'tla',
  })
})
`,
      'evals/circ-a.ts':
        "import { b } from './circ-b'\nexport const a = 'A'\nexport function fromB() { return b() }\n",
      'evals/circ-b.ts':
        "import { a } from './circ-a'\nexport function b() { return 'B sees ' + a }\n",
      'evals/lib.cjs': "module.exports = { named: 'N', kind: 'cjs' }\n",
      'evals/data.json': '{ "k": 1 }\n',
      'evals/mod.mts': "export const m: string = 'mts'\n",
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(readRun(p.dir).evals[0]?.outcome, 'pass')
  })

  test('each eval file runs in a process of its own: module state and globals never cross files', async () => {
    const body = (name: string) => `import { evaluate, expect } from 'reeval'
import { state } from './shared'
state.n++
;(globalThis as Record<string, unknown>)['${name}'] = true
evaluate('${name}', async () => {
  expect(state.n).toBe(1)
  expect(Object.keys(globalThis).filter((k) => k === 'a' || k === 'b')).toEqual(['${name}'])
})
`
    const p = await project('isolation', {
      'reeval.config.ts': fakeConfig(),
      'evals/shared.ts': 'export const state = { n: 0 }\n',
      'evals/a.eval.ts': body('a'),
      'evals/b.eval.ts': body('b'),
    })
    const r = await runCli(p.dir, ['run', '--concurrency', '1'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
  })

  test("a tsconfig that isn't JSON fails every eval file loudly; comments and trailing commas are fine", async () => {
    const p = await project('tsconfig-json', {
      'reeval.config.ts': fakeConfig(),
      'tsconfig.json': '{ bad json',
      'evals/a.eval.ts': math(1),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /evals\/a\.eval\.ts: .*Failed to load tsconfig 'tsconfig\.json'/)
    await writeFile(
      join(p.dir, 'tsconfig.json'),
      '{\n  // ok\n  "compilerOptions": { "strict": true, },\n}\n',
    )
    const fine = await runCli(p.dir)
    assert.equal(fine.code, 0, fine.stdout + fine.stderr)
  })

  test('.only narrows only the file it is in', async () => {
    const p = await project('only-per-file', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'
evaluate('a kept', async () => {})
evaluate.only('a focused', async () => {})
`,
      'evals/b.eval.ts': `import { evaluate } from 'reeval'
evaluate('b runs', async () => {})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.deepEqual(
      readRun(p.dir).evals.map((e) => [e.id, e.outcome]),
      [
        ['evals/a.eval.ts › a kept', 'skipped'],
        ['evals/a.eval.ts › a focused', 'pass'],
        ['evals/b.eval.ts › b runs', 'pass'],
      ],
    )
  })

  test("an uncaught exception or unhandled rejection in an eval's worker fails the run; the other evals still finish", async () => {
    const p = await project('worker-uncaught', {
      'reeval.config.ts': fakeConfig(),
      'evals/stray.eval.ts': `import { evaluate } from 'reeval'
evaluate('throws later', async () => {
  setTimeout(() => { throw new Error('stray throw') }, 0)
  void Promise.reject(new Error('stray rejection'))
  await new Promise((resolve) => setTimeout(resolve, 50))
})
evaluate('fine', async () => {})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /stray throw/)
    assert.match(r.stdout, /stray rejection/)
    assert.deepEqual(
      readRun(p.dir).evals.map((e) => e.outcome),
      ['pass', 'pass'],
    )
  })

  test('a worker killed mid-attempt fails its attempts, names the file, and the run goes on', async () => {
    const p = await project('worker-killed', {
      'reeval.config.ts': fakeConfig(),
      'evals/dies.eval.ts': `import { evaluate } from 'reeval'
evaluate('killed', async (c) => {
  await c.sandbox()
  process.kill(process.pid, 'SIGKILL')
})
`,
      'evals/lives.eval.ts': math(1),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      process.platform === 'win32'
        ? /The worker running evals\/dies\.eval\.ts exited unexpectedly \(exit code 1\)/
        : /The worker running evals\/dies\.eval\.ts exited unexpectedly \(signal SIGKILL\)/,
    )
    assert.deepEqual(
      readRun(p.dir).evals.map((e) => [e.id, e.outcome]),
      [
        ['evals/dies.eval.ts › killed', 'fail'],
        ['evals/lives.eval.ts › math', 'pass'],
      ],
    )
  })

  test('a worker that runs out of memory fails its attempts too', async () => {
    const p = await project('worker-oom', {
      'reeval.config.ts': fakeConfig(),
      'evals/oom.eval.ts': `import { evaluate } from 'reeval'
import { setFlagsFromString } from 'node:v8'
evaluate('grows', async () => {
  setFlagsFromString('--max-old-space-size=32')
  const hoard: string[][] = []
  for (;;) hoard.push(new Array(1e6).fill('x'.repeat(8)))
})
`,
    })
    const r = await runCli(p.dir, ['run'], { timeoutMs: 120_000 })
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /The worker running evals\/oom\.eval\.ts exited unexpectedly/)
    assert.equal(readRun(p.dir).evals[0]?.outcome, 'fail')
  })

  test('a name declared twice in one file is a usage error naming it', async () => {
    const p = await project('duplicate-name', {
      'reeval.config.ts': fakeConfig(),
      'evals/d.eval.ts': `import { evaluate } from 'reeval'
evaluate('same', async () => {})
evaluate('same', async () => {})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /evals\/d\.eval\.ts: evaluate\("same"\) is declared twice in this file/)
  })

  test('nothing reeval ships imports vitest or vite; only engine/ imports @vitest/*', () => {
    const src = join(pkgRoot, 'src')
    const files = readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
    const importing = (pattern: RegExp) =>
      files
        .filter((path) => pattern.test(readFileSync(path, 'utf8')))
        .map((p) => p.slice(src.length + 1).replaceAll(sep, '/'))
    assert.deepEqual(importing(/from ['"](vitest|vite)(\/[^'"]*)?['"]/), [])
    const vitestParts = importing(/from ['"]@vitest\//)
    assert.ok(vitestParts.length > 0, 'the canary: the engine does import @vitest/expect')
    assert.deepEqual(
      vitestParts.filter((p) => !p.startsWith('engine/')),
      [],
    )
  })
})

describe('evaluate wrapper with the fake harness', () => {
  const agentEval = (body: string, options = '') => `
import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
evaluate('agent eval', ${options ? `${options}, ` : ''}async (c) => {
  const turn = await c.send('write hello.txt')
  ${body}
})
`

  test('turns, diff, checks and verdicts land in the run directory', async () => {
    const big = 'x'.repeat(200_000)
    const p = await project('data-out', {
      'reeval.config.ts': fakeConfig({
        harness: `{ files: { 'hello.txt': 'hi\\n', 'big.txt': '${big}' }, text: 'Wrote hello.txt' }`,
      }),
      'evals/agent.eval.ts': agentEval(`
  await expect(turn).toHaveFile('hello.txt', /hi/)
  await expect(c).toHaveFile('big.txt')
  await expect(c.exec('cat hello.txt')).toSucceed()
  expect(turn.diff.files).toEqual(expect.arrayContaining([{ path: 'hello.txt', status: 'added' }]))
  expect(turn.text).toMatch(/hello/)
  expect(await c.judge('Did it write hello.txt?')).toPass()
`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /judge {2}pass 0\.90 \(≥ 0\.8\) {2}Did it write hello\.txt\?/)

    const [e] = readRun(p.dir).evals
    assert.ok(e)
    assert.equal(e.outcome, 'pass')
    assert.equal(e.trial.turns.length, 1)
    assert.equal(e.trial.turns[0]?.text, 'Wrote hello.txt')
    assert.equal(e.trial.turns[0]?.status, 'completed')
    const transcript = e
      .read(e.trial.files.transcript?.path ?? '')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.deepEqual(
      { ...transcript[0], ts: undefined },
      { ts: undefined, atMs: 0, turn: 0, type: 'prompt', text: 'write hello.txt' },
    )
    for (const event of transcript)
      assert.ok(!Number.isNaN(Date.parse(event.ts)), 'every line is timestamped')
    assert.deepEqual(
      transcript
        .filter((t) => t.type === 'file-edit')
        .map(({ path, kind, added, removed }) => ({ path, kind, added, removed })),
      [
        { path: 'hello.txt', kind: 'create', added: 1, removed: 0 },
        { path: 'big.txt', kind: 'create', added: 1, removed: 0 },
      ],
    )
    assert.equal(transcript.at(-1).type, 'turn-end')
    assert.equal(transcript.at(-1).durationMs, e.trial.turns[0]?.durationMs)
    assert.match(e.read(e.trial.files.diff?.path ?? ''), /\+hi/)
    assert.equal(e.trial.turns[0]?.text, 'Wrote hello.txt', 'the final message lives in the record')
    assert.equal('final' in e.trial.files, false)
    const t = e.trial.timings
    assert.ok(t.setupMs >= 0 && t.agentMs >= 0 && t.checksMs >= 0 && t.judgeMs >= 0)
    assert.equal(e.trial.activity.fileEdits, 2)
    // The fake agent reports everything it does, so no web events is a real count of 0.
    assert.deepEqual(e.trial.turns[0]?.unreported, [])
    assert.equal(e.trial.activity.webFetches, 0)
    assert.equal(typeof e.trial.checks[0]?.durationMs, 'number')
    assert.deepEqual(e.trial.changedFiles.map((f) => f.path).sort(), ['big.txt', 'hello.txt'])
    assert.deepEqual(
      e.trial.checks.map(({ command, exitCode }) => ({ command, exitCode })),
      [{ command: 'cat hello.txt', exitCode: 0 }],
    )
    assert.match(
      e.read(e.trial.checks[0]?.log.path ?? ''),
      /^\$ cat hello\.txt\nexit 0\n--- stdout\nhi\n/,
    )
    assert.deepEqual(e.trial.judgements, [
      {
        verdict: 'pass',
        score: 0.9,
        threshold: 0.8,
        question: 'Did it write hello.txt?',
        model: 'fake',
        key: `0:${createHash('sha256').update('Did it write hello.txt?').digest('hex').slice(0, 12)}`,
      },
    ])
    const [input] = JSON.parse(e.read(e.trial.files.judgeInput?.path ?? ''))
    assert.equal(input.question, 'Did it write hello.txt?')
    assert.equal(input.state.task, 'write hello.txt')
    assert.equal(e.trial.id, 'fake/fake/fake#1')
    assert.match(
      e.trial.files.diff?.path ?? '',
      new RegExp(`^${e.slug}/fake-fake-fake-[0-9a-f]{6}/1/diff\\.patch$`),
    )
    assert.equal(
      e.trial.files.transcript?.path,
      e.trial.files.diff?.path.replace('diff.patch', 'transcript.jsonl'),
    )
    assert.deepEqual(liveSandboxes(p), [], 'sandbox destroyed')
  })

  test('a second c.send continues the same sandbox and session', async () => {
    const p = await project('multi-turn', {
      'reeval.config.ts': fakeConfig({ harness: `{ files: { 'n.txt': 'x' }, text: 'ok' }` }),
      'evals/agent.eval.ts': agentEval(`
  await c.exec('echo 1 > counter')
  const second = await c.send('again')
  expect(second.prompt).toBe('again')
  expect(c.turns).toEqual([turn, second])
  expect(await c.readFile('counter')).toBe('1\\n')
  expect(second.diff.files.map((f) => f.path).sort()).toEqual(['counter', 'n.txt'])
`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const [e] = readRun(p.dir).evals
    assert.deepEqual(
      e?.trial.turns.map((x) => x.prompt),
      ['write hello.txt', 'again'],
    )
    assert.deepEqual(liveSandboxes(p), [])
  })

  test('judge options cascade from config to group, eval and call', async () => {
    const p = await project('judge-cascade', {
      'reeval.config.ts': fakeConfig(),
      'evals/j.eval.ts': `import { evaluate, expect, group } from 'reeval'
import { fakeJudge } from 'reeval/judge'
group('strict', { judge: { threshold: 0.95 } }, () => {
  evaluate('group threshold', async (c) => {
    await c.send('x')
    expect(await c.judge('from group')).toMatchObject({ verdict: 'fail', score: 0.9, threshold: 0.95 })
  })
  evaluate('eval model', { judge: { model: fakeJudge({ score: 0.5 }) } }, async (c) => {
    await c.send('x')
    expect(await c.judge('from eval')).toMatchObject({ verdict: 'fail', score: 0.5, threshold: 0.95 })
    expect(await c.judge('from call', { threshold: 0.4 })).toMatchObject({ verdict: 'pass', score: 0.5 })
  })
})
evaluate('on a value', async (c) => {
  const first = await c.send('first')
  await c.send('second')
  expect(await c.judge('custom', { on: 'some output' })).toMatchObject({ verdict: 'pass' })
  expect(await c.judge('earlier turn', { on: first })).toMatchObject({ verdict: 'pass' })
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(readRun(p.dir).evals[1]?.trial.judgements.length, 2)
  })

  test('plain output streams worker progress and console.log from inside the eval', async () => {
    const p = await project('plain-progress', {
      'reeval.config.ts': fakeConfig({ harness: "{ files: { 'hello.txt': 'hi' } }" }),
      'evals/agent.eval.ts': agentEval(`console.log('hello from', 'the eval')
  await expect(c.exec('cat hello.txt')).toSucceed()`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const tag = /^\[agent#1 fake\] {2}\+0:\d\d /
    const detail = r.stdout
      .split('\n')
      .filter((l) => tag.test(l))
      .map((l) => l.replace(tag, ''))
    assert.deepEqual(
      detail.map((l) => l.replace(/ \d+m?s\b/g, '')),
      [
        'sandbox starting',
        'sandbox ready',
        'turn 1 started',
        'turn 1 done · 0 tool calls, 1 file edit',
        'stdout | hello from the eval',
        '$ cat hello.txt',
        '$ cat hello.txt  exit 0',
        'cleaning up',
      ],
    )
    assert.match(r.stdout, /^\[agent#1 fake\] ✓ evals\/agent\.eval\.ts › agent eval {2}\d+m?s$/m)
  })

  test('--log-order, --log-prefix and --output-logs shape what reeval run prints', async () => {
    // Two attempts of one file run at once in one worker; each logs after the other has started.
    const p = await project('output-flags', {
      'reeval.config.ts': fakeConfig(),
      'evals/o.eval.ts': `import { evaluate, expect } from 'reeval'
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
evaluate('passes', async (c) => {
  await c.send('go')
  await pause(400)
  console.log('log from passes')
})
evaluate('fails', async (c) => {
  await pause(200)
  await c.send('go')
  console.error('log from fails')
  expect(1).toBe(2)
})
`,
    })
    const run = (...flags: string[]) =>
      runCli(p.dir, ['run', '--ui', 'plain', '--concurrency', '2', ...flags])
    const lines = (out: string) => out.slice(0, out.indexOf('\nSummary')).split('\n')

    const stream = await run('--log-order', 'stream', '--log-prefix', 'task')
    assert.equal(stream.code, 1, stream.stdout + stream.stderr)
    assert.match(stream.stdout, / · stream logs$/m)
    const logs = lines(stream.stdout).filter((l) => /(stdout|stderr) \| log from/.test(l))
    assert.deepEqual(
      logs.map((l) => l.replace(/ {2}\+0:\d\d /, ' ')).sort(),
      ['[fails#1 fake] stderr | log from fails', '[passes#1 fake] stdout | log from passes'],
      'each console line is prefixed with the attempt that logged it',
    )

    const grouped = await run(
      '--log-order',
      'grouped',
      '--log-prefix',
      'none',
      '--output-logs',
      'errors-only',
    )
    assert.equal(grouped.code, 1, grouped.stdout + grouped.stderr)
    assert.match(grouped.stdout, / · grouped logs$/m)
    const out = lines(grouped.stdout)
    assert.ok(!out.some((l) => l.includes('log from passes')), 'a passing attempt prints no detail')
    const head = out.findIndex((l) => l.startsWith('[fails#1 fake] ✗ evals/o.eval.ts › fails'))
    const rest = out.slice(head + 1)
    const next = rest.findIndex((l) => l.startsWith('['))
    const block = next < 0 ? rest : rest.slice(0, next)
    assert.ok(head >= 0, grouped.stdout)
    assert.ok(
      block.some((l) => /^ \+0:\d\d stderr \| log from fails$/.test(l)),
      `the failing attempt's detail follows its result line, unprefixed:\n${grouped.stdout}`,
    )

    const none = await run('--output-logs', 'none')
    assert.equal(none.code, 1)
    assert.doesNotMatch(lines(none.stdout).join('\n'), /log from|sandbox ready|AssertionError/)

    const byEnv = await runCli(p.dir, ['run', '--ui', 'plain'], {
      env: { REEVAL_LOG_ORDER: 'grouped' },
    })
    assert.match(byEnv.stdout, / · grouped logs$/m, 'REEVAL_LOG_ORDER stands in for the flag')
    const bad = await run('--log-order', 'sideways')
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /--log-order must be one of stream, grouped, auto/)
  })

  test('agent mode prints failures only, with record and summary paths, and no colour', async () => {
    const p = await project('agent-mode', {
      'reeval.config.ts': fakeConfig({ judge: '{ model: fakeJudge({ score: 0.3 }) }' }),
      'evals/agent.eval.ts': `${agentEval(`expect(await c.judge('ok?')).toPass()`)}
evaluate('passes', async () => {})
`,
    })
    const r = await runCli(p.dir, ['run'], {
      env: { REEVAL_UI: 'agent', NO_COLOR: '', FORCE_COLOR: '' },
    })
    assert.equal(r.code, 1)
    const [plan, ...out] = r.stdout.trimEnd().split('\n')
    assert.match(plan ?? '', /^plan {2}(?:run \S+ · )?2 evals · 2 cells · 2 attempts · ~/)
    assert.match(out[0] ?? '', /^reeval run: \S+ · 1 eval file$/)
    assert.match(out[1] ?? '', /^FAIL evals\/agent\.eval\.ts › agent eval \(\d+m?s, judge\)$/)
    assert.equal(out[2], '  judge  fail 0.30 (≥ 0.8)  ok?')
    assert.match(
      out[3] ?? '',
      /^ {2}record: \.reeval\/runs\/[^/]+\/evals-agent-eval-ts-agent-eval-[0-9a-f]{6}\/fake-fake-fake-[0-9a-f]{6}\/1$/,
    )
    assert.equal(out[4], '1 passed, 1 failed')
    assert.match(out[5] ?? '', /^summary: \.reeval\/runs\/[^/]+\/summary\.md$/)
    assert.equal(out.length, 6)
    assert.ok(existsSync(join(p.dir, (out[3] ?? '').replace('  record: ', ''))))
    assert.ok(!r.stdout.includes('\x1b['))
  })

  test('a failing judge fails the eval as a judge error', async () => {
    const p = await project('judge-fail', {
      'reeval.config.ts': fakeConfig({ judge: '{ model: fakeJudge({ score: 0.3 }) }' }),
      'evals/agent.eval.ts': agentEval(`expect(await c.judge('ok?')).toPass()`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /judge {2}fail 0\.30/)
    assert.match(r.stdout, /Judge failures \(1\)\n ✗ evals\/agent\.eval\.ts › agent eval/)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.trial.judgements[0]?.verdict, 'fail')
    assert.equal(e?.error?.kind, 'judge')
    const shown = await runCli(p.dir, ['show'])
    assert.match(shown.stdout, /judge fail 0\.30 \(≥ 0\.8\) {2}ok\?/)
    assert.doesNotMatch(shown.stdout, /judge score/, 'the verdict is printed once')
    const summary = readRun(p.dir).read('summary.md')
    assert.match(summary, /Judge \*\*fail\*\* 0\.30/)
    assert.doesNotMatch(summary, /judge score/, 'the verdict is printed once')
  })

  test('a model judge makes a real provider call: the request carries the question and transcript, the verdict the reply', async () => {
    // A Gemini API stand-in: P(true) comes from the question, so one eval passes and one fails.
    const requests: { path: string; key: string | undefined; body: string }[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      requests.push({ path: req.url ?? '', key: req.headers['x-goog-api-key'] as string, body })
      const p = body.includes('Is the greeting friendly?') ? 0.92 : 0.12
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: JSON.stringify({ q0: p }) }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5, totalTokenCount: 45 },
          modelVersion: 'gemini-stand-in-001',
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const google = pathToFileURL(join(pkgRoot, 'node_modules/@ai-sdk/google/dist/index.js')).href
      const p = await project('judge-model', {
        'reeval.config.ts': fakeConfig({ harness: `{ text: 'Hello, friend!' }` }),
        'evals/judged.eval.ts': `import { evaluate, expect, group } from 'reeval'
import { createGoogleGenerativeAI } from '${google}'
const gemini = createGoogleGenerativeAI({ baseURL: 'http://127.0.0.1:${port}/v1beta', apiKey: 'reeval-judge-test-key' })
group('model judge', { judge: { model: gemini.evaluationModel('gemini-under-test') } }, () => {
  evaluate('friendly', async (c) => {
    await c.send('greet me')
    expect(await c.judge('Is the greeting friendly?')).toPass()
  })
  evaluate('canary', async (c) => {
    await c.send('greet me')
    expect(await c.judge('Is the greeting in French?')).toPass()
  })
})
`,
      })
      const r = await runCli(p.dir)
      assert.equal(r.code, 1, r.stdout + r.stderr)
      const byName = Object.fromEntries(readRun(p.dir).evals.map((e) => [e.name, e]))
      const friendly = byName.friendly?.trial.judgements[0]
      assert.equal(byName.friendly?.outcome, 'pass', r.stdout)
      assert.deepEqual([friendly?.verdict, friendly?.score], ['pass', 0.92])
      // @ai-sdk/google reports the model it asked for, not the reply's modelVersion.
      assert.equal(friendly?.resolvedModel, 'gemini-under-test')
      assert.equal(byName.canary?.outcome, 'fail')
      assert.equal(byName.canary?.error?.kind, 'judge')
      assert.equal(byName.canary?.trial.judgements[0]?.score, 0.12)

      assert.equal(requests.length, 2, 'one call per judge, no retries')
      for (const req of requests) {
        assert.equal(req.path, '/v1beta/models/gemini-under-test:generateContent')
        assert.equal(req.key, 'reeval-judge-test-key')
        assert.match(req.body, /Hello, friend!/, 'the transcript is in the state the judge sees')
      }
    } finally {
      server.close()
    }
  })

  test('a judge that errors fails the eval as a judge error', async () => {
    const p = await project('judge-error', {
      'reeval.config.ts': fakeConfig(),
      'evals/agent.eval.ts': agentEval(`await c.judge('ok?', { model: 'no-provider' })`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /needs a provider prefix/)
    assert.equal(readRun(p.dir).evals[0]?.error?.kind, 'judge')
  })

  const judgeInputs = (e: ReturnType<typeof readRun>['evals'][number] | undefined) =>
    JSON.parse(e?.read(e.trial.files.judgeInput?.path ?? '') ?? '[]') as Array<{
      question: string
      state: Record<string, unknown>
      dropped?: string[]
      error?: string
      retries?: unknown[]
    }>

  test('a judge call that fails is recorded, and the judges and checks after it still run', async () => {
    const p = await project('judge-soft', {
      'reeval.config.ts': fakeConfig(),
      'evals/agent.eval.ts': agentEval(`
  const failed = await c.judge('first?', { model: 'no-provider' })
  expect(failed).toMatchObject({ verdict: 'error', score: null, question: 'first?' })
  expect.soft(failed, 'an errored judge fails .not.toPass() too').not.toPass()
  expect.soft(await c.judge('second?')).toPass()
  await expect.soft(c.exec('echo checked')).toSucceed()
`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.error?.kind, 'judge')
    assert.match(
      e?.error?.message ?? '',
      /judge failed for "first\?" \(no-provider\): Judge model "no-provider" needs a provider prefix/,
    )
    assert.deepEqual(
      e?.trial.judgements.map((j) => [j.question, j.verdict]),
      [['second?', 'pass']],
    )
    assert.deepEqual(
      e?.trial.checks.map((c) => c.command),
      ['echo checked'],
    )
    const inputs = judgeInputs(e)
    assert.deepEqual(
      inputs.map((i) => i.question),
      ['first?', 'second?'],
    )
    assert.match(inputs[0]?.error ?? '', /needs a provider prefix/)
    assert.doesNotMatch(
      inputs[0]?.error ?? '',
      /judge's input was/,
      'reeval’s own errors say no more',
    )
    assert.equal(inputs[1]?.error, undefined)
  })

  test('a judge failure the eval never asserts on still fails the attempt, after its body', async () => {
    const p = await project('judge-unasserted', {
      'reeval.config.ts': fakeConfig(),
      'evals/agent.eval.ts': agentEval(`
  await c.judge('first?', { model: 'no-provider' })
  await c.judge('again?', { model: 'no-provider' })
  await c.exec('echo after')
`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.error?.kind, 'judge')
    assert.match(e?.error?.message ?? '', /^2 judge calls failed:\nc\.judge\("first\?"\) failed: /)
    assert.match(e?.error?.message ?? '', /\nc\.judge\("again\?"\) failed: /)
    assert.deepEqual(
      e?.trial.checks.map((c) => c.command),
      ['echo after'],
    )
  })

  test('judge include and files cascade from the config to the call; build output is dropped', async () => {
    const p = await project('judge-scope', {
      'reeval.config.ts': fakeConfig({
        harness: `{ files: { 'src/app.ts': 'export const app = 1\\n', 'notes.md': 'notes\\n', 'dist/app.js': 'bundle\\n' } }`,
        judge: `{ model: fakeJudge({ score: 0.9 }), include: ['src/'] }`,
      }),
      'evals/scope.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const env = defineEnvironment('scoped', { sandbox: fakeSandbox(), files: { 'README.md': 'the readme\\n' } })
evaluate('scope', { environment: env }, async (c) => {
  await c.send('go')
  expect(await c.judge('from the config')).toPass()
  expect(await c.judge('from the call', { include: [], files: ['README.md', './src/app.ts'] })).toPass()
  expect(await c.judge('a missing file', { files: ['gone.txt'] })).toPass()
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const [fromConfig, fromCall, missing] = judgeInputs(readRun(p.dir).evals[0])
    assert.deepEqual(fromConfig?.state.files, ['added src/app.ts'])
    assert.match(String(fromConfig?.state.diff), /\+export const app = 1/)
    assert.doesNotMatch(String(fromConfig?.state.diff), /notes|dist/)
    assert.deepEqual(fromConfig?.dropped, [
      'dist/app.js: not in include',
      'notes.md: not in include',
    ])
    assert.equal(fromConfig?.state.contents, undefined)

    assert.deepEqual(fromCall?.state.files, [
      'added notes.md',
      'added src/app.ts',
      'changed dist/ (1 file)',
    ])
    assert.match(
      String(fromCall?.state.diff),
      /\[reeval: dropped dist\/ \(1 file\): build output\]/,
    )
    assert.match(String(fromCall?.state.diff), /\+notes/)
    assert.doesNotMatch(String(fromCall?.state.diff), /export const app/, 'shown once, in full')
    assert.deepEqual(fromCall?.state.contents, {
      'README.md': 'the readme\n',
      'src/app.ts': 'export const app = 1\n',
    })
    assert.deepEqual(fromCall?.dropped, ['dist/ (1 file): build output'])

    assert.deepEqual(missing?.state.contents, { 'gone.txt': null })
    assert.deepEqual(missing?.state.files, ['added src/app.ts'], 'the config include still applies')
  })

  test("a provider's error keeps its wording and names what filled the judge's input", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 422
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const typesafe = pathToFileURL(
        join(pkgRoot, 'node_modules/@ai-sdk/typesafe-ai/dist/index.js'),
      ).href
      const p = await project('judge-provider-overflow', {
        'reeval.config.ts': fakeConfig({ harness: `{ files: { 'src/app.ts': 'export {}\\n' } }` }),
        'evals/agent.eval.ts': `import { evaluate, expect } from 'reeval'
import { createTypeSafeAi } from '${typesafe}'
const jev = createTypeSafeAi({ baseURL: 'http://127.0.0.1:${port}/v1', apiKey: 'reeval-test-key' })
evaluate('agent eval', async (c) => {
  await c.send('go')
  expect.soft(await c.judge('Is it done?', { model: jev.evaluationModel('jev-under-test') })).toPass()
})
`,
      })
      const r = await runCli(p.dir)
      assert.equal(r.code, 1, r.stdout + r.stderr)
      const [e] = readRun(p.dir).evals
      assert.equal(e?.error?.kind, 'judge')
      assert.match(
        e?.error?.message ?? '',
        /\{"error_type":"max_tokens_exceeded"\}\nThe judge's input was ~\d+ tokens \(estimated\): .*include/,
      )
      assert.equal(judgeInputs(e)[0]?.retries, undefined, 'not retried')
    } finally {
      server.close()
    }
  })

  test('a judge call retries a transient provider error and records it', async () => {
    const p = await project('judge-retry', {
      'reeval.config.ts': fakeConfig(),
      'evals/agent.eval.ts': `import { evaluate, expect } from 'reeval'
let calls = 0
const flaky = {
  specificationVersion: 'v4',
  provider: 'mock',
  modelId: 'flaky',
  supportedQuestionTypes: ['boolean'],
  async doEvaluate() {
    if (calls++ === 0) {
      throw Object.assign(new Error('The model is overloaded due to high demand'), { statusCode: 503 })
    }
    return { answers: { answer: { type: 'boolean', probability: 0.9 } }, warnings: [] }
  },
}
evaluate('agent eval', async (c) => {
  await c.send('x')
  expect(await c.judge('ok?', { model: flaky })).toPass()
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const [j] = readRun(p.dir).evals[0]?.trial.judgements ?? []
    assert.equal(j?.verdict, 'pass')
    assert.equal(j?.model, 'mock/flaky')
    assert.equal(j?.retries?.length, 1)
    assert.equal(j?.retries?.[0]?.error, 'The model is overloaded due to high demand')
    assert.match(readRun(p.dir).read('summary.md'), /mock\/flaky, after 1 retry\): ok\?/)
  })

  test('c.judge before any turn is an assertion error', async () => {
    const p = await project('judge-early', {
      'reeval.config.ts': fakeConfig(),
      'evals/j.eval.ts': `import { evaluate } from 'reeval'
evaluate('early', async (c) => { await c.judge('?') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /c\.judge\(\) has no turn to grade/)
  })

  test('c.judge with an empty question or a threshold outside 0…1 fails without asking the judge', async () => {
    const p = await project('judge-bad-call', {
      'reeval.config.ts': fakeConfig(),
      'evals/j.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('empty', async (c) => { await c.send('go'); await c.judge('  ') })
evaluate('over one', async (c) => { await c.send('go'); await c.judge('Is it ok?', { threshold: 2 }) })
evaluate('fine', async (c) => { await c.send('go'); expect(await c.judge('Is it ok?', { threshold: 0.5 })).toPass() })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /c\.judge\(\) needs a question: a non-empty string \(got " {2}"\)/)
    assert.match(r.stdout, /c\.judge\(\) threshold must be between 0 and 1 \(got 2\)/)
    const judged = Object.fromEntries(
      readRun(p.dir).evals.map((e) => [e.name, e.attempts[0]?.judgements.length]),
    )
    // The canary: a valid call is judged, so a count of 0 means the bad ones never reached it.
    assert.deepEqual(judged, { empty: 0, 'over one': 0, fine: 1 })
  })

  test('c.judge artifacts must be a capture handle or name on this attempt', async () => {
    const p = await project('judge-artifacts-call', {
      'reeval.config.ts': fakeConfig(),
      'evals/j.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('not a list', async (c) => {
  await c.send('go')
  await c.judge('ok?', { artifacts: 'form' as never })
})
evaluate('unknown name', async (c) => {
  await c.send('go')
  await c.judge('ok?', { artifacts: ['missing'] })
})
evaluate('fine', async (c) => {
  await c.send('go')
  expect(await c.judge('ok?')).toPass()
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /c\.judge\(\) artifacts must be a list of capture handles or names/)
    assert.match(r.stdout, /artifacts names a capture this attempt doesn't have: "missing"/)
    const judged = Object.fromEntries(
      readRun(p.dir).evals.map((e) => [e.name, e.attempts[0]?.judgements.length]),
    )
    assert.deepEqual(judged, { 'not a list': 0, 'unknown name': 0, fine: 1 })
  })

  test('a failing check shows the tail of stderr', async () => {
    const p = await project('check-fail', {
      'reeval.config.ts': fakeConfig(),
      'evals/agent.eval.ts': agentEval(`await expect(c.exec('echo boom >&2; exit 3')).toSucceed()`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /exit code 3/)
    assert.match(r.stdout, /boom/)
  })

  test('a failure with megabytes of output prints and records a bounded tail', async () => {
    const p = await project('huge-failure', {
      'reeval.config.ts': fakeConfig(),
      'evals/h.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('noisy check', async (c) => {
  await c.send('go')
  await expect(c.exec('head -c 3000000 /dev/zero | tr "\\\\0" b; echo boom >&2; exit 3')).toSucceed()
})
evaluate('huge diff', async (c) => {
  await c.sandbox()
  expect('a'.repeat(3_000_000)).toBe('x')
})
`,
    })
    const r = await runCli(p.dir, ['run', '--ui', 'plain'])
    assert.equal(r.code, 1, r.stderr)
    const screen = r.stdout + r.stderr
    assert.ok(screen.length < 200_000, `the screen got ${screen.length} characters`)
    const { run } = readRun(p.dir)
    for (const e of run.evals) {
      const message = e.attempts[0]?.error?.message ?? ''
      assert.ok(message.length <= 20_000, `${e.name}: a ${message.length}-character error`)
    }
    // The canary: what tells you why is still there, on screen and in the record.
    assert.match(screen, /expected command to succeed, exit code 3/)
    assert.match(screen, /boom/)
    assert.match(screen, /to be 'x'/)
    const noisy = run.evals.find((e) => e.name === 'noisy check')?.attempts[0]?.error?.message
    assert.match(noisy ?? '', /exit code 3[\s\S]*boom[\s\S]*bbbb/)
  })

  test("a turn's error message shows in the summary, agent output and summary.md without -v", async () => {
    const billing = 'Credit balance is too low to access the Anthropic API'
    const p = await project('turn-error', {
      'reeval.config.ts': fakeConfig({ harness: `{ script: [[{ error: '${billing}' }]] }` }),
      'evals/agent.eval.ts': agentEval(`expect(turn.status).toBe('completed')`),
    })
    const plain = await runCli(p.dir)
    assert.equal(plain.code, 1, plain.stdout + plain.stderr)
    const summary = plain.stdout.slice(plain.stdout.indexOf('\nSummary'))
    assert.match(summary, new RegExp(`\\n {3}turn 1 error: ${billing}\\n`))
    assert.match(plain.stdout, new RegExp(`turn 1 error: ${billing} \\d+m?s · 0 tool calls`))
    const { run, read } = readRun(p.dir)
    assert.equal(run.evals[0]?.attempts[0]?.turns[0]?.error, billing)
    assert.match(read('summary.md'), new RegExp(`- Error: ${billing}`))
    const agent = await runCli(p.dir, ['run'], { env: { REEVAL_UI: 'agent' } })
    assert.match(agent.stdout, new RegExp(`\\n {2}turn 1 error: ${billing}\\n`))
  })

  test('the resolved model variant is in the record, the stack, -v and summary.md', async () => {
    const served = 'composer-2.5[fast=true]'
    const p = await project('served-model', {
      'reeval.config.ts': fakeConfig({ harness: `{ servedModel: '${served}' }` }),
      'evals/agent.eval.ts': agentEval(''),
    })
    const r = await runCli(p.dir, ['run', '-v'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      / harness {3}turn 1 completed in \S+ · .* · model composer-2\.5\[fast=true\]$/m,
    )
    const { run, read } = readRun(p.dir)
    assert.equal(run.evals[0]?.attempts[0]?.turns[0]?.model, served)
    assert.deepEqual(run.stack.harnesses, [
      {
        id: 'fake',
        kind: 'fake',
        model: null,
        effort: null,
        resolvedModels: [served],
        resolvedEffort: [],
      },
    ])
    assert.match(
      read('summary.md'),
      /\| Harnesses \| fake \(served composer-2\.5\[fast=true\]\) \|/,
    )

    // Canary: a harness that reports no model shows none.
    await writeFile(join(p.dir, 'reeval.config.ts'), fakeConfig())
    const quiet = await runCli(p.dir, ['run', '-v'])
    assert.equal(quiet.code, 0, quiet.stdout + quiet.stderr)
    assert.doesNotMatch(quiet.stdout, / · model /)
    const again = readRun(p.dir)
    assert.deepEqual(again.run.stack.harnesses[0]?.resolvedModels, [])
    assert.match(again.read('summary.md'), /\| Harnesses \| fake \|/)
  })

  test('an unawaited toHaveFile or toSucceed fails its eval, and runs before teardown', async () => {
    const p = await project('unawaited', {
      'reeval.config.ts': fakeConfig(),
      'evals/file.eval.ts': agentEval(`expect(turn).toHaveFile('missing.txt')`),
      'evals/exec.eval.ts': agentEval(
        `expect(c.exec('sleep 0.3; echo ran > late.txt')).toSucceed()`,
      ).replace("'agent eval'", "'unawaited pass'"),
      'evals/awaited.eval.ts': agentEval(
        `await expect(c.exec('exit 2')).not.toSucceed()\n  await expect(turn).not.toHaveFile('missing.txt')`,
      ).replace("'agent eval'", "'awaited'"),
    })
    const r = await runCli(p.dir)
    const out = r.stdout + r.stderr
    assert.equal(r.code, 1, out)
    const { run, evals } = readRun(p.dir)
    const byName = Object.fromEntries(evals.map((e) => [e.name, e]))
    assert.equal(byName['agent eval']?.trial.outcome, 'fail', out)
    assert.equal(byName['agent eval']?.error?.kind, 'assertion')
    assert.match(byName['agent eval']?.error?.message ?? '', /expected file missing\.txt to exist/)
    assert.match(
      byName['agent eval']?.error?.message ?? '',
      /expect\(…\)\.toHaveFile\(\) wasn't awaited\. Its check is async: write `await expect\(…\)\.toHaveFile\(\)`/,
    )
    // A check that would pass still fails its eval unawaited, and it finished before teardown.
    assert.equal(byName['unawaited pass']?.trial.outcome, 'fail', out)
    assert.match(byName['unawaited pass']?.error?.message ?? '', /toSucceed\(\) wasn't awaited/)
    assert.equal(byName['unawaited pass']?.trial.checks[0]?.exitCode, 0, 'the check completed')
    assert.equal(byName.awaited?.trial.outcome, 'pass', out)
    assert.equal(run.summary.fail, 2)
    assert.doesNotMatch(out, /Summary[\s\S]*\n\s*error: /, 'no stray error after the summary')
  })

  test('expect.soft, expect.poll and expect.assertions work inside an attempt', async () => {
    const p = await project('expect-extras', {
      'reeval.config.ts': fakeConfig(),
      'evals/x.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('soft', async () => {
  expect.soft(1).toBe(2)
  expect(3).toBe(3)
})
evaluate('counted', async () => {
  expect.assertions(2)
  expect(1).toBe(1)
})
evaluate('polled', async () => {
  let n = 0
  await expect.poll(() => ++n, { interval: 5 }).toBe(3)
  expect(n).toBe(3)
  expect.assertions(2)
})
evaluate('asserted nothing', async () => {
  expect.hasAssertions()
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const byName = Object.fromEntries(readRun(p.dir).evals.map((e) => [e.name, e]))
    assert.equal(byName.soft?.outcome, 'fail')
    assert.match(byName.soft?.error?.message ?? '', /expected 1 to be 2/)
    assert.equal(byName.counted?.outcome, 'fail')
    assert.match(
      byName.counted?.error?.message ?? '',
      /expected number of assertions to be 2, but got 1/,
    )
    assert.equal(byName['asserted nothing']?.outcome, 'fail')
    // The canary: a poll that reaches its value, with the right count, passes.
    assert.equal(byName.polled?.outcome, 'pass', r.stdout)
  })

  test('an eval with not-gated cells labels its pass rate gated; an all-gated one does not', async () => {
    const p = await project('gated-label', {
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
evaluate('compared', { compare: { baseline: plain, variants: [skilled] }, runs: 2 }, async (c) => {
  await c.send('go')
  await expect(c).toHaveFile('ok.txt')
})
evaluate('repeated', { runs: 4 }, async (c) => {
  await c.send('go')
  expect(c.attempt.n % 4).not.toBe(0)
})
`,
    })
    const r = await runCli(p.dir)
    const summary = r.stdout.slice(r.stdout.indexOf('\nSummary'))
    // The control's two failures count in 2/4, but only the gated variant's 2/2 in the rate.
    assert.match(summary, /✓ compared +2\/4 · 100% gated {2}4 attempts\n/)
    assert.match(summary, /✗ repeated +3\/4 +75% {2}4 attempts\n/)
  })

  test("a harness whose session never becomes ready is an infra error, once retried; its sandbox goes, other evals don't wait", async () => {
    const p = await project('start-hangs', {
      'reeval.config.ts': fakeConfig(),
      'evals/hang.eval.ts': `import { evaluate, expect } from 'reeval'
import { fakeHarness } from 'reeval/harness'
evaluate('stuck start', { harness: fakeHarness({ startHangs: true, startTimeout: '1s' }) }, async (c) => {
  await c.send('go')
})
evaluate('fine', async () => expect(1).toBe(1))
`,
    })
    const started = Date.now()
    const r = await runCli(p.dir, ['run', '--concurrency', '1'], { timeoutMs: 30_000 })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms`)
    const byName = Object.fromEntries(readRun(p.dir).evals.map((e) => [e.name, e]))
    assert.equal(byName['stuck start']?.outcome, 'infra_error')
    assert.deepEqual(byName['stuck start']?.error, {
      kind: 'infra',
      message: 'fake: session did not become ready within 1s (tried twice)',
    })
    assert.deepEqual(
      byName['stuck start']?.trial.startRetries?.map((s) => s.error),
      ['fake: session did not become ready within 1s'],
    )
    assert.equal(byName.fine?.outcome, 'pass', 'the other eval ran')
    assert.deepEqual(liveSandboxes(p), [], 'sandbox destroyed')
  })

  test('a session that hangs once becomes ready on its retry, recorded; one that starts at once is not retried', async () => {
    const p = await project('start-hangs-once', {
      'reeval.config.ts': fakeConfig(),
      'evals/once.eval.ts': `import { evaluate } from 'reeval'
import { fakeHarness } from 'reeval/harness'
evaluate('recovers', { harness: fakeHarness({ id: 'flaky', startHangs: 1, startTimeout: '1s' }) }, async (c) => {
  await c.send('go')
})
evaluate('canary', { harness: fakeHarness({ id: 'steady', startTimeout: '1s' }) }, async (c) => {
  await c.send('go')
})
`,
    })
    const r = await runCli(p.dir, ['run'], { timeoutMs: 30_000 })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const byName = Object.fromEntries(readRun(p.dir).evals.map((e) => [e.name, e]))
    assert.equal(byName.recovers?.outcome, 'pass')
    assert.deepEqual(
      byName.recovers?.trial.startRetries?.map((s) => s.error),
      ['fake: session did not become ready within 1s'],
    )
    assert.equal(byName.canary?.outcome, 'pass')
    assert.equal(byName.canary?.trial.startRetries, undefined, 'the canary: no retry')
    assert.deepEqual(liveSandboxes(p), [])
  })

  test('startTimeout must be a duration', async () => {
    const p = await project('start-timeout-bad', {
      'reeval.config.ts': fakeConfig({ harness: "{ startTimeout: 'soon' }" }),
      'evals/math.eval.ts': math(1),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /startTimeout of harness in reeval\.config\.ts: Invalid duration "soon"/)

    // An operational limit, like maxConcurrent: results with and without it stay comparable.
    const fingerprint = async (harness: string) => {
      await writeFile(join(p.dir, 'reeval.config.ts'), fakeConfig({ harness }))
      const run = await runCli(p.dir)
      assert.equal(run.code, 0, run.stdout + run.stderr)
      return readRun(p.dir).evals[0]?.cells[0]?.fingerprint
    }
    assert.equal(await fingerprint("{ startTimeout: '5s' }"), await fingerprint('{}'))
  })

  test('a harness failure is an infra error and exits 3', async () => {
    const p = await project('infra', {
      'reeval.config.ts': fakeConfig({ harness: `{ failWith: 'agent CLI failed to start' }` }),
      'evals/agent.eval.ts': agentEval(''),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 3, r.stdout)
    assert.match(r.stdout, /! evals\/agent\.eval\.ts › agent eval/)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.outcome, 'infra_error')
    assert.deepEqual(e?.error, { kind: 'infra', message: 'agent CLI failed to start' })
    assert.deepEqual(liveSandboxes(p), [])
  })

  test('a failure outranks an infra error in the same run: exit 1, not 3', async () => {
    const p = await project('precedence', {
      'reeval.config.ts': fakeConfig(),
      'evals/agent.eval.ts': `import { evaluate, expect } from 'reeval'
import { fakeHarness } from 'reeval/harness'
evaluate('broken agent', { harness: fakeHarness({ failWith: 'agent CLI failed to start' }) }, async (c) => {
  await c.send('go')
})
evaluate('wrong answer', async () => expect(1).toBe(2))
evaluate('fine', async () => {})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const { run } = readRun(p.dir)
    assert.deepEqual(
      run.evals.map((e) => [e.name, e.outcome]),
      [
        ['broken agent', 'infra_error'],
        ['wrong answer', 'fail'],
        ['fine', 'pass'],
      ],
    )
    const infraOnly = await runCli(p.dir, ['run', 'broken agent', 'fine'])
    assert.equal(infraOnly.code, 3, 'without the failure, the infra error exits 3')
  })

  test('a turn whose agent ignores the abort is cut off shortly after the timeout', async () => {
    const p = await project('stuck-turn', {
      'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 60_000, ignoreAbort: true }' }),
      'evals/agent.eval.ts': agentEval('', `{ timeout: '2s' }`),
    })
    const started = Date.now()
    const r = await runCli(p.dir)
    const out = r.stdout + r.stderr
    assert.equal(r.code, 1, out)
    assert.ok(Date.now() - started < 15_000, `waited ${Date.now() - started}ms for a stuck turn`)
    assert.match(out, /Eval timed out after 2s/)
    assert.doesNotMatch(out, /Hook timed out|hookTimeout/)
    const [e] = readRun(p.dir).evals
    const [turn] = e?.attempts[0]?.turns ?? []
    // The canary: the stuck turn is still in the record, marked as cut off.
    assert.equal(turn?.status, 'aborted')
    assert.equal(e?.error?.kind, 'timeout')
    assert.deepEqual(liveSandboxes(p), [])
  })

  test('a timeout aborts the agent and destroys the sandbox', async () => {
    const p = await project('timeout', {
      'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 60_000 }' }),
      'evals/agent.eval.ts': agentEval('', `{ timeout: '1s' }`),
    })
    const started = Date.now()
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.ok(Date.now() - started < 20_000, 'did not wait for the agent')
    assert.match(r.stdout, /Eval timed out after 1s/)
    assert.doesNotMatch(r.stdout, /testTimeout/)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.outcome, 'fail')
    assert.equal(e?.error?.kind, 'timeout')
    assert.deepEqual(liveSandboxes(p), [])
  })

  for (const [target, signal, code] of [
    [
      'Ctrl-C mid-turn to the CLI only exits 130',
      (pid: number) => process.kill(pid, 'SIGINT'),
      130,
    ],
    [
      'Ctrl-C mid-turn to the process group, like a terminal, exits 130',
      (pid: number) => process.kill(-pid, 'SIGINT'),
      130,
    ],
    [
      'SIGTERM mid-turn to the CLI, like docker stop, exits 143',
      (pid: number) => process.kill(pid, 'SIGTERM'),
      143,
    ],
  ] as const) {
    test(`${target}, records the run and destroys the sandbox`, { skip: noSignals }, async () => {
      const p = await project('sigint', {
        'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 60_000 }' }),
        'evals/agent.eval.ts': agentEval(''),
      })
      const r = await runCli(p.dir, ['run'], {
        onOutput: (stdout, pid) => {
          if (/\] {2}\+\d+:\d\d turn 1 started$/m.test(stdout)) {
            signal(pid)
            return true
          }
          return false
        },
      })
      assert.equal(r.code, code, r.stdout + r.stderr)
      const { run, evals } = readRun(p.dir)
      assert.equal(run.status, 'interrupted')
      assert.equal(evals[0]?.outcome, 'fail')
      assert.equal(evals[0]?.error?.kind, 'aborted')
      assert.match(r.stdout, /Cancelled \(1\)\n ✗ evals\/agent\.eval\.ts › agent eval/)
      assert.match(r.stdout, /Evals {2}1 cancelled/)
      assert.deepEqual(liveSandboxes(p), [])
    })
  }

  test('an unhandled rejection in the main process mid-run prints it, redacted, and exits 3', async () => {
    const secret = 'sk-live-0123456789abcdefghij'
    const p = await project('unhandled', {
      'reeval.config.ts': `${fakeConfig({ harness: '{ delayMs: 60_000 }' })}
import { existsSync } from 'node:fs'
// The test writes ./boom (a signal would do, but Windows has none to send); workers have process.send.
const boom = setInterval(() => {
  if (process.send || !existsSync('boom')) return
  clearInterval(boom)
  Promise.reject(new Error(\`main process boom with \${process.env.REEVAL_TEST_API_KEY}\`))
}, 50)
boom.unref()
`,
      'evals/agent.eval.ts': agentEval(''),
    })
    const r = await runCli(p.dir, ['run'], {
      env: { REEVAL_TEST_API_KEY: secret },
      onOutput: (stdout) => {
        if (!/\] {2}\+\d+:\d\d turn 1 started$/m.test(stdout)) return false
        writeFileSync(join(p.dir, 'boom'), '')
        return true
      },
    })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(r.stderr, /reeval: main process boom with /)
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secret))
  })

  for (const [how, stop, code] of [
    ['crashes (exit 3)', (_pid: number, dir: string) => writeFileSync(join(dir, 'boom'), ''), 3],
    // Windows has no signals: the kill is TerminateProcess, with exit code 1.
    [
      'is killed (SIGKILL)',
      (pid: number) => process.kill(pid, 'SIGKILL'),
      process.platform === 'win32' ? 1 : null,
    ],
  ] as const) {
    test(`when the main process ${how} mid-turn, its worker cancels, destroys the sandbox and exits`, async () => {
      const p = await project('main-gone', {
        'reeval.config.ts': `${fakeConfig({ harness: '{ delayMs: 60_000 }' })}
import { existsSync } from 'node:fs'
// The test writes ./boom (a signal would do, but Windows has none to send); workers have process.send.
const boom = setInterval(() => {
  if (process.send || !existsSync('boom')) return
  clearInterval(boom)
  Promise.reject(new Error('main process boom'))
}, 50)
boom.unref()
`,
        'evals/agent.eval.ts': `import { writeFileSync } from 'node:fs'
import { evaluate } from 'reeval'
evaluate('agent eval', async (c) => {
  writeFileSync(new URL('../worker.pid', import.meta.url), String(process.pid))
  await c.send('write hello.txt')
})
`,
      })
      const r = await runCli(p.dir, ['run'], {
        onOutput: (stdout, pid) => {
          if (!/\] {2}\+\d+:\d\d turn 1 started$/m.test(stdout)) return false
          stop(pid, p.dir)
          return true
        },
      })
      assert.equal(r.code, code, r.stdout + r.stderr)
      const worker = Number(readFileSync(join(p.dir, 'worker.pid'), 'utf8'))
      const alive = () => {
        try {
          process.kill(worker, 0)
          return true
        } catch {
          return false
        }
      }
      const deadline = Date.now() + 15_000
      while ((alive() || liveSandboxes(p).length) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(alive(), false, 'the worker exited')
      assert.deepEqual(liveSandboxes(p), [], 'the sandbox was destroyed')
    })
  }

  test('Ctrl-C while the worker boots still cancels the attempt before it starts', {
    skip: noSignals,
  }, async () => {
    const p = await project('sigint-early', {
      'reeval.config.ts': fakeConfig({ harness: '{ delayMs: 60_000 }' }),
      'evals/agent.eval.ts': agentEval(''),
    })
    const r = await runCli(p.dir, ['run'], {
      timeoutMs: 20_000,
      onOutput: (stdout, pid) => {
        if (!/^reeval /m.test(stdout)) return false
        process.kill(pid, 'SIGINT')
        return true
      },
    })
    assert.equal(r.code, 130, r.stdout + r.stderr)
    assert.equal(readRun(p.dir).run.status, 'interrupted')
    assert.deepEqual(liveSandboxes(p), [])
  })
})
