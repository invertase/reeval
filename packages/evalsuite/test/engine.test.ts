import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { vitestMismatch } from '../src/engine/node.ts'
import { fakeConfig, liveSandboxes, pkgRoot, project, readRun, runCli, tempDir } from './helpers.ts'

const math = (value: number) => `
import { evaluate, expect } from 'evalsuite'
evaluate('math', async () => expect(1).toBe(${value}))
`

describe('engine', () => {
  test('a passing eval exits 0 with no Vitest branding', async () => {
    const p = await project('pass', { 'es.config.ts': fakeConfig(), 'evals/math.es.ts': math(1) })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /✓ evals\/math\.es\.ts › math/)
    assert.match(r.stdout, /Evals {2}1 passed \(1\)/)
    assert.match(
      r.stdout,
      /Results {2}\.es\/runs\/\d{8}T\d{6}Z_[0-9a-z]+_[a-z0-9-]+_[0-9a-z]{4}\/summary\.md/,
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
    assert.equal(run.evals[0]?.id, 'evals/math.es.ts › math')
    assert.ok(!existsSync(join(p.dir, '.es/attachments')), 'no copies of the records')
    assert.ok(!existsSync(join(p.dir, '.es/staging', run.runId)), 'staging cleaned up')
  })

  test('a failing assertion exits 1', async () => {
    const p = await project('fail', { 'es.config.ts': fakeConfig(), 'evals/math.es.ts': math(2) })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /✗ evals\/math\.es\.ts › math/)
    assert.doesNotMatch(r.stdout + r.stderr, /vitest/i)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.outcome, 'fail')
    assert.equal(e?.error?.kind, 'assertion')
    assert.match(e?.error?.message ?? '', /expected 1 to be 2/)
  })

  test('filters match paths, then eval names', async () => {
    const p = await project('filter', {
      'es.config.ts': fakeConfig(),
      'evals/a.es.ts': math(1),
      'evals/b.es.ts': `import { evaluate } from 'evalsuite'\nevaluate('named thing', async () => {})\n`,
    })
    const byPath = await runCli(p.dir, ['run', 'a.es'])
    assert.equal(byPath.code, 0)
    assert.match(byPath.stdout, /a\.es\.ts › math/)
    assert.doesNotMatch(byPath.stdout, /named thing/)

    const byName = await runCli(p.dir, ['run', 'named thing'])
    assert.equal(byName.code, 0)
    assert.match(byName.stdout, /b\.es\.ts › named thing/)
    assert.doesNotMatch(byName.stdout, /› math/)

    const { runId } = readRun(p.dir).run
    const none = await runCli(p.dir, ['run', 'nope'])
    assert.equal(none.code, 2, none.stdout + none.stderr)
    assert.match(none.stderr, /No evals matched evals\/\*\*\/\*\.es\.ts with filter "nope"/)
    assert.equal(readRun(p.dir).run.runId, runId, 'no empty run written')
    assert.deepEqual(readdirSync(join(p.dir, '.es/staging')), [], 'no staging left behind')
  })

  test('a path filter and a cell filter together run only that cell of that file', async () => {
    const p = await project('mixed-filter', {
      'es.config.ts': `import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'
export default defineConfig({
  harness: [fakeHarness({ id: 'left' }), fakeHarness({ id: 'right' })],
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
`,
      'evals/scaffold.es.ts': math(1),
      'evals/other.es.ts': math(1),
    })
    const r = await runCli(p.dir, ['run', 'scaffold', 'right/', '--ui', 'plain'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, / · harness right · /, 'the header names only the harness that runs')
    const { evals } = readRun(p.dir)
    assert.deepEqual(
      evals.map((e) => [e.id, e.cells.map((c) => c.key)]),
      [['evals/scaffold.es.ts › math', ['right/-/fake']]],
    )
  })

  test('eval files that declare no evals exit 2 instead of writing an empty run', async () => {
    const p = await project('no-evals', {
      'es.config.ts': fakeConfig(),
      'evals/empty.es.ts': `import { evaluate } from 'evalsuite'\nvoid evaluate\n`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /No evals matched evals\/\*\*\/\*\.es\.ts/)
    assert.ok(!existsSync(join(p.dir, '.es/runs')), 'no run written')
  })

  for (const [what, body, message] of [
    ['throws', `throw new Error('boom at import')`, /evals\/bad\.es\.ts: boom at import/],
    ['imports a missing file', `import './nope.ts'`, /evals\/bad\.es\.ts: .*nope\.ts/],
    [
      'has a syntax error',
      `evaluate('f' async () => {})`,
      /evals\/bad\.es\.ts: Transform failed[\s\S]*Expected `,` or `\)`/,
    ],
  ] as const) {
    test(`an eval file that ${what} exits 2 naming it, next to a good file`, async () => {
      const p = await project('bad-eval-file', {
        'es.config.ts': fakeConfig(),
        'evals/good.es.ts': `import { evaluate } from 'evalsuite'\nevaluate('good', async () => {})\n`,
        'evals/bad.es.ts': `import { evaluate } from 'evalsuite'\n${body}\nevaluate('bad', async () => {})\n`,
      })
      for (const args of [['run'], ['run', '--dry-run']]) {
        const r = await runCli(p.dir, args)
        assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
        assert.match(r.stderr, message)
        assert.ok(!existsSync(join(p.dir, '.es/runs')), 'no run written')
      }
    })
  }

  test('a tsconfig that extends a missing file fails every eval file loudly, once', async () => {
    const p = await project('bad-tsconfig', {
      'es.config.ts': fakeConfig(),
      'tsconfig.json': '{ "extends": "../../tsconfig.base.json" }',
      'evals/a.es.ts': `import { evaluate } from 'evalsuite'\nevaluate('a', async () => {})\n`,
      'evals/b.es.ts': `import { evaluate } from 'evalsuite'\nevaluate('b', async () => {})\n`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(
      r.stderr,
      /2 eval files failed to load:\nevals\/a\.es\.ts, evals\/b\.es\.ts: [\s\S]*Failed to load tsconfig '\.\.\/\.\.\/tsconfig\.base\.json'/,
    )
    assert.equal(r.stderr.includes('\u001b['), false, 'no terminal colours')
  })

  test('groups nest, cascade options and appear in ids and result.json', async () => {
    const p = await project('groups', {
      'es.config.ts': fakeConfig(),
      'evals/g.es.ts': `import { evaluate, expect, group } from 'evalsuite'
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
    assert.match(r.stdout, /✗ evals\/g\.es\.ts › outer › inner › slow/)
    assert.match(r.stdout, /✓ evals\/g\.es\.ts › outer › fast/)
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

    const filtered = await runCli(p.dir, ['run', 'outer fast'])
    assert.equal(filtered.code, 0, filtered.stdout)
    assert.deepEqual(
      readRun(p.dir).evals.map((e) => e.name),
      ['fast'],
    )
  })

  test('skip is reported as skipped', async () => {
    const p = await project('skip', {
      'es.config.ts': fakeConfig(),
      'evals/s.es.ts': `import { evaluate } from 'evalsuite'
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
      'es.config.ts': fakeConfig(),
      'evals/g.es.ts': `import { evaluate, group } from 'evalsuite'
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
        ['evals/g.es.ts › parked › inside', 'skipped'],
        ['evals/g.es.ts › parked › nested › deeper', 'skipped'],
        ['evals/g.es.ts › kept', 'pass'],
      ],
      'a todo group has no evals, so it adds none',
    )
    assert.equal(run.summary.skipped, 2)
  })

  test('.env.local wins over .env, the shell wins over both, and evals see them', async () => {
    const p = await project('dotenv', {
      'es.config.ts': `import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'
const id = (name: string) => process.env[name] ?? 'unset'
export default defineConfig({
  harness: [fakeHarness({ id: id('ES_T_BOTH') }), fakeHarness({ id: id('ES_T_ENV') }), fakeHarness({ id: id('ES_T_SHELL') })],
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
`,
      '.env': 'ES_T_BOTH=from-env\nES_T_ENV=only-env\nES_T_SHELL=from-env\n',
      '.env.local': 'ES_T_BOTH=from-local\nES_T_SHELL=from-local\n',
      'evals/sees.es.ts': `import { evaluate, expect } from 'evalsuite'
evaluate('sees', async () => expect(process.env.ES_T_BOTH).toBe('from-local'))
`,
      'evals/canary.es.ts': `import { evaluate, expect } from 'evalsuite'
evaluate('canary', async () => expect(process.env.ES_T_BOTH).toBe('from-env'))
`,
    })
    const env = { ES_T_SHELL: 'from-shell' }
    const plan = await runCli(p.dir, ['run', '--dry-run', '--json'], { env })
    assert.equal(plan.code, 0, plan.stdout + plan.stderr)
    const cells = JSON.parse(plan.stdout).evals[0].cells.map((c: { key: string }) => c.key)
    assert.deepEqual(cells, ['from-local/-/fake', 'only-env/-/fake', 'from-shell/-/fake'])

    const sees = await runCli(p.dir, ['run', 'sees.es'], { env })
    assert.equal(sees.code, 0, sees.stdout + sees.stderr)
    const canary = await runCli(p.dir, ['run', 'canary.es'], { env })
    assert.equal(canary.code, 1, canary.stdout + canary.stderr)
    assert.match(
      readRun(p.dir).evals[0]?.error?.message ?? '',
      /expected 'from-local' to be 'from-env'/,
    )
  })

  test('usage errors exit 2', async () => {
    const empty = await project('empty', { 'es.config.ts': fakeConfig() })
    const none = await runCli(empty.dir)
    assert.equal(none.code, 2)
    assert.match(
      none.stderr,
      /No eval files match evals\/\*\*\/\*\.es\.ts \(config\.include\) in \S*empty\S*\. Name eval files to match it, or set include in es\.config\.ts\./,
    )

    assert.equal((await runCli(empty.dir, ['run', '--config', 'missing.ts'])).code, 2)
    assert.equal((await runCli(empty.dir, ['bogus'])).code, 2)
    assert.equal((await runCli(empty.dir, ['--help'])).code, 0)

    const real = await project('creds', {
      'es.config.ts': `import { defineConfig } from 'evalsuite'\nexport default defineConfig({})\n`,
      'evals/math.es.ts': math(1),
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
      'es.config.ts': fakeConfig(),
      'evals/math.es.ts': math(1),
      'node_modules/vitest/package.json': '{ "name": "vitest", "version": "3.2.0" }',
      'vitest.config.ts': 'export default {}\n',
      'src/sum.test.ts': "throw new Error('ES must not run the project tests')\n",
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stderr, /warning/)
    assert.deepEqual(
      readRun(p.dir).evals.map((e) => e.id),
      ['evals/math.es.ts › math'],
    )
  })

  test('an evalsuite on another copy of vitest is reported', async () => {
    const dir = tempDir('other-evalsuite')
    const manifest = (name: string) =>
      JSON.stringify({ name, exports: { './package.json': './package.json' } })
    const vitest = join(dir, 'node_modules/evalsuite/node_modules/vitest')
    await mkdir(vitest, { recursive: true })
    await writeFile(join(dir, 'node_modules/evalsuite/package.json'), manifest('evalsuite'))
    await writeFile(join(vitest, 'package.json'), manifest('vitest'))
    assert.match(vitestMismatch(dir) ?? '', /uses another copy of vitest/)
    assert.equal(vitestMismatch((await project('same-evalsuite', {})).dir), undefined)

    const { name } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    const published = tempDir('other-published')
    const publishedVitest = join(published, 'node_modules', name, 'node_modules/vitest')
    await mkdir(publishedVitest, { recursive: true })
    await writeFile(join(published, 'node_modules', name, 'package.json'), manifest(name))
    await writeFile(join(publishedVitest, 'package.json'), manifest('vitest'))
    assert.match(vitestMismatch(published) ?? '', /uses another copy of vitest/)
  })

  test('another copy of vitest is reported even when its version is in range', async () => {
    const ours = JSON.parse(
      readFileSync(join(pkgRoot, 'node_modules/vitest/package.json'), 'utf8'),
    ).version
    const [major, minor] = ours.split('.')
    for (const version of [ours, `${major}.${minor}.999`]) {
      const dir = tempDir(`in-range-${version}`)
      const vitest = join(dir, 'node_modules/evalsuite/node_modules/vitest')
      await mkdir(vitest, { recursive: true })
      await writeFile(
        join(dir, 'node_modules/evalsuite/package.json'),
        JSON.stringify({ name: 'evalsuite', exports: { './package.json': './package.json' } }),
      )
      await writeFile(
        join(vitest, 'package.json'),
        JSON.stringify({
          name: 'vitest',
          version,
          exports: { './package.json': './package.json' },
        }),
      )
      const warning = vitestMismatch(dir) ?? ''
      assert.match(
        warning,
        new RegExp(`another copy of vitest \\(${version.replaceAll('.', '\\.')} at `),
      )
      assert.match(warning, new RegExp(`this es \\(${ours.replaceAll('.', '\\.')} at `))
      assert.match(warning, /won't register/)
    }
  })

  test('only the engine module imports vitest', () => {
    const src = join(pkgRoot, 'src')
    const offenders = readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter(
        (path) =>
          !path.includes('/src/engine/') &&
          /['"]vitest(\/[^'"]*)?['"]/.test(readFileSync(path, 'utf8')),
      )
    assert.deepEqual(offenders, [])
  })
})

describe('evaluate wrapper with the fake harness', () => {
  const agentEval = (body: string, options = '') => `
import { evaluate, expect } from 'evalsuite'
import { fakeJudge } from 'evalsuite/judge'
evaluate('agent eval', ${options ? `${options}, ` : ''}async (t) => {
  const turn = await t.send('write hello.txt')
  ${body}
})
`

  test('turns, diff, checks and verdicts land in the run directory', async () => {
    const big = 'x'.repeat(200_000)
    const p = await project('data-out', {
      'es.config.ts': fakeConfig({
        harness: `{ files: { 'hello.txt': 'hi\\n', 'big.txt': '${big}' }, text: 'Wrote hello.txt' }`,
      }),
      'evals/agent.es.ts': agentEval(`
  await expect(turn).toHaveFile('hello.txt', /hi/)
  await expect(t).toHaveFile('big.txt')
  await expect(t.exec('cat hello.txt')).toSucceed()
  expect(turn.diff.files).toEqual(expect.arrayContaining([{ path: 'hello.txt', status: 'added' }]))
  expect(turn.text).toMatch(/hello/)
  expect(await t.judge('Did it write hello.txt?')).toPass()
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
    assert.equal(e.trial.id, 'fake/-/fake#1')
    assert.match(
      e.trial.files.diff?.path ?? '',
      new RegExp(`^${e.slug}/fake-fake-[0-9a-f]{6}/1/diff\\.patch$`),
    )
    assert.equal(
      e.trial.files.transcript?.path,
      e.trial.files.diff?.path.replace('diff.patch', 'transcript.jsonl'),
    )
    assert.deepEqual(liveSandboxes(p), [], 'sandbox destroyed')
  })

  test('a second t.send continues the same sandbox and session', async () => {
    const p = await project('multi-turn', {
      'es.config.ts': fakeConfig({ harness: `{ files: { 'n.txt': 'x' }, text: 'ok' }` }),
      'evals/agent.es.ts': agentEval(`
  await t.exec('echo 1 > counter')
  const second = await t.send('again')
  expect(second.prompt).toBe('again')
  expect(t.turns).toEqual([turn, second])
  expect(await t.readFile('counter')).toBe('1\\n')
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
      'es.config.ts': fakeConfig(),
      'evals/j.es.ts': `import { evaluate, expect, group } from 'evalsuite'
import { fakeJudge } from 'evalsuite/judge'
group('strict', { judge: { threshold: 0.95 } }, () => {
  evaluate('group threshold', async (t) => {
    await t.send('x')
    expect(await t.judge('from group')).toMatchObject({ verdict: 'fail', score: 0.9, threshold: 0.95 })
  })
  evaluate('eval model', { judge: { model: fakeJudge({ score: 0.5 }) } }, async (t) => {
    await t.send('x')
    expect(await t.judge('from eval')).toMatchObject({ verdict: 'fail', score: 0.5, threshold: 0.95 })
    expect(await t.judge('from call', { threshold: 0.4 })).toMatchObject({ verdict: 'pass', score: 0.5 })
  })
})
evaluate('on a value', async (t) => {
  const first = await t.send('first')
  await t.send('second')
  expect(await t.judge('custom', { on: 'some output' })).toMatchObject({ verdict: 'pass' })
  expect(await t.judge('earlier turn', { on: first })).toMatchObject({ verdict: 'pass' })
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(readRun(p.dir).evals[1]?.trial.judgements.length, 2)
  })

  test('plain output streams worker progress and console.log from inside the eval', async () => {
    const p = await project('plain-progress', {
      'es.config.ts': fakeConfig({ harness: "{ files: { 'hello.txt': 'hi' } }" }),
      'evals/agent.es.ts': agentEval(`console.log('hello from', 'the eval')
  await expect(t.exec('cat hello.txt')).toSucceed()`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const tag = /^\[agent#1 fake\] {2}\+0:\d\d /
    const detail = r.stdout
      .split('\n')
      .filter((l) => tag.test(l))
      .map((l) => l.replace(tag, ''))
    assert.deepEqual(
      detail.map((l) => l.replace(/ \d+ms/g, '')),
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
    assert.match(r.stdout, /^\[agent#1 fake\] ✓ evals\/agent\.es\.ts › agent eval {2}\d+ms$/m)
  })

  test('--log-order, --log-prefix and --output-logs shape what es run prints', async () => {
    // Two attempts of one file run at once in one worker; each logs after the other has started.
    const p = await project('output-flags', {
      'es.config.ts': fakeConfig(),
      'evals/o.es.ts': `import { evaluate, expect } from 'evalsuite'
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
evaluate('passes', async (t) => {
  await t.send('go')
  await pause(400)
  console.log('log from passes')
})
evaluate('fails', async (t) => {
  await pause(200)
  await t.send('go')
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
    const head = out.findIndex((l) => l.startsWith('[fails#1 fake] ✗ evals/o.es.ts › fails'))
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
      env: { ES_LOG_ORDER: 'grouped' },
    })
    assert.match(byEnv.stdout, / · grouped logs$/m, 'ES_LOG_ORDER stands in for the flag')
    const bad = await run('--log-order', 'sideways')
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /--log-order must be one of stream, grouped, auto/)
  })

  test('agent mode prints failures only, with record and summary paths, and no colour', async () => {
    const p = await project('agent-mode', {
      'es.config.ts': fakeConfig({ judge: '{ model: fakeJudge({ score: 0.3 }) }' }),
      'evals/agent.es.ts': `${agentEval(`expect(await t.judge('ok?')).toPass()`)}
evaluate('passes', async () => {})
`,
    })
    const r = await runCli(p.dir, ['run'], {
      env: { ES_UI: 'agent', NO_COLOR: '', FORCE_COLOR: '' },
    })
    assert.equal(r.code, 1)
    const [plan, ...out] = r.stdout.trimEnd().split('\n')
    assert.match(plan ?? '', /^plan {2}2 evals · 2 cells · 2 attempts · ~/)
    assert.equal(out[0], 'es run: 1 eval file')
    assert.match(out[1] ?? '', /^FAIL evals\/agent\.es\.ts › agent eval \(\d+ms, judge\)$/)
    assert.equal(out[2], '  judge  fail 0.30 (≥ 0.8)  ok?')
    assert.match(
      out[3] ?? '',
      /^ {2}record: \.es\/runs\/[^/]+\/evals-agent-es-ts-agent-eval-[0-9a-f]{6}\/fake-fake-[0-9a-f]{6}\/1$/,
    )
    assert.equal(out[4], '1 passed, 1 failed')
    assert.match(out[5] ?? '', /^summary: \.es\/runs\/[^/]+\/summary\.md$/)
    assert.equal(out.length, 6)
    assert.ok(existsSync(join(p.dir, (out[3] ?? '').replace('  record: ', ''))))
    assert.ok(!r.stdout.includes('\x1b['))
  })

  test('a failing judge fails the eval as a judge error', async () => {
    const p = await project('judge-fail', {
      'es.config.ts': fakeConfig({ judge: '{ model: fakeJudge({ score: 0.3 }) }' }),
      'evals/agent.es.ts': agentEval(`expect(await t.judge('ok?')).toPass()`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /judge {2}fail 0\.30/)
    assert.match(r.stdout, /Judge failures \(1\)\n ✗ evals\/agent\.es\.ts › agent eval/)
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

  test('a judge that errors fails the eval as a judge error', async () => {
    const p = await project('judge-error', {
      'es.config.ts': fakeConfig(),
      'evals/agent.es.ts': agentEval(`await t.judge('ok?', { model: 'no-provider' })`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /needs a provider prefix/)
    assert.equal(readRun(p.dir).evals[0]?.error?.kind, 'judge')
  })

  test('a judge call retries a transient provider error and records it', async () => {
    const p = await project('judge-retry', {
      'es.config.ts': fakeConfig(),
      'evals/agent.es.ts': `import { evaluate, expect } from 'evalsuite'
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
evaluate('agent eval', async (t) => {
  await t.send('x')
  expect(await t.judge('ok?', { model: flaky })).toPass()
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

  test('t.judge before any turn is an assertion error', async () => {
    const p = await project('judge-early', {
      'es.config.ts': fakeConfig(),
      'evals/j.es.ts': `import { evaluate } from 'evalsuite'
evaluate('early', async (t) => { await t.judge('?') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /t\.judge\(\) has no turn to grade/)
  })

  test('a failing check shows the tail of stderr', async () => {
    const p = await project('check-fail', {
      'es.config.ts': fakeConfig(),
      'evals/agent.es.ts': agentEval(`await expect(t.exec('echo boom >&2; exit 3')).toSucceed()`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /exit code 3/)
    assert.match(r.stdout, /boom/)
  })

  test("a turn's error message shows in the summary, agent output and summary.md without -v", async () => {
    const billing = 'Credit balance is too low to access the Anthropic API'
    const p = await project('turn-error', {
      'es.config.ts': fakeConfig({ harness: `{ script: [[{ error: '${billing}' }]] }` }),
      'evals/agent.es.ts': agentEval(`expect(turn.status).toBe('completed')`),
    })
    const plain = await runCli(p.dir)
    assert.equal(plain.code, 1, plain.stdout + plain.stderr)
    const summary = plain.stdout.slice(plain.stdout.indexOf('\nSummary'))
    assert.match(summary, new RegExp(`\\n {3}turn 1 error: ${billing}\\n`))
    assert.match(plain.stdout, new RegExp(`turn 1 error: ${billing} \\d+ms · 0 tool calls`))
    const { run, read } = readRun(p.dir)
    assert.equal(run.evals[0]?.attempts[0]?.turns[0]?.error, billing)
    assert.match(read('summary.md'), new RegExp(`- Error: ${billing}`))
    const agent = await runCli(p.dir, ['run'], { env: { ES_UI: 'agent' } })
    assert.match(agent.stdout, new RegExp(`\\n {2}turn 1 error: ${billing}\\n`))
  })

  test('an unawaited toHaveFile or toSucceed fails its eval, and runs before teardown', async () => {
    const p = await project('unawaited', {
      'es.config.ts': fakeConfig(),
      'evals/file.es.ts': agentEval(`expect(turn).toHaveFile('missing.txt')`),
      'evals/exec.es.ts': agentEval(
        `expect(t.exec('sleep 0.3; echo ran > late.txt')).toSucceed()`,
      ).replace("'agent eval'", "'unawaited pass'"),
      'evals/awaited.es.ts': agentEval(
        `await expect(t.exec('exit 2')).not.toSucceed()\n  await expect(turn).not.toHaveFile('missing.txt')`,
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

  test('an eval with not-gated cells labels its pass rate gated; an all-gated one does not', async () => {
    const p = await project('gated-label', {
      'es.config.ts': fakeConfig({ harness: "{ withSkill: { files: { 'ok.txt': 'y' } } }" }),
      'skills/s/SKILL.md': '---\nname: s\ndescription: A skill. Use when testing.\n---\nBody.\n',
      'evals/c.es.ts': `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const skilled = defineEnvironment('skilled', ({ skill }) => ({ skills: [skill.local('../skills/s')] }))
evaluate('compared', { compare: [skilled], runs: 2 }, async (t) => {
  await t.send('go')
  await expect(t).toHaveFile('ok.txt')
})
evaluate('repeated', { runs: 4 }, async (t) => {
  await t.send('go')
  expect(t.attempt.n % 4).not.toBe(0)
})
`,
    })
    const r = await runCli(p.dir)
    const summary = r.stdout.slice(r.stdout.indexOf('\nSummary'))
    // The control's two failures count in 2/4, but only the gated variant's 2/2 in the rate.
    assert.match(summary, /✓ compared +2\/4 · 100% gated {2}4 attempts\n/)
    assert.match(summary, /✗ repeated +3\/4 +75% {2}4 attempts\n/)
  })

  test('a harness failure is an infra error and exits 3', async () => {
    const p = await project('infra', {
      'es.config.ts': fakeConfig({ harness: `{ failWith: 'agent CLI failed to start' }` }),
      'evals/agent.es.ts': agentEval(''),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 3, r.stdout)
    assert.match(r.stdout, /! evals\/agent\.es\.ts › agent eval/)
    const [e] = readRun(p.dir).evals
    assert.equal(e?.outcome, 'infra_error')
    assert.deepEqual(e?.error, { kind: 'infra', message: 'agent CLI failed to start' })
    assert.deepEqual(liveSandboxes(p), [])
  })

  test('a failure outranks an infra error in the same run: exit 1, not 3', async () => {
    const p = await project('precedence', {
      'es.config.ts': fakeConfig(),
      'evals/agent.es.ts': `import { evaluate, expect } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
evaluate('broken agent', { harness: fakeHarness({ failWith: 'agent CLI failed to start' }) }, async (t) => {
  await t.send('go')
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

  test('a timeout aborts the agent and destroys the sandbox', async () => {
    const p = await project('timeout', {
      'es.config.ts': fakeConfig({ harness: '{ delayMs: 60_000 }' }),
      'evals/agent.es.ts': agentEval('', `{ timeout: '1s' }`),
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

  for (const [target, signal] of [
    ['Ctrl-C mid-turn to the CLI only', (pid: number) => process.kill(pid, 'SIGINT')],
    [
      'Ctrl-C mid-turn to the process group, like a terminal',
      (pid: number) => process.kill(-pid, 'SIGINT'),
    ],
    [
      'SIGTERM mid-turn to the CLI, like docker stop',
      (pid: number) => process.kill(pid, 'SIGTERM'),
    ],
  ] as const) {
    test(`${target} exits 130, records the run and destroys the sandbox`, async () => {
      const p = await project('sigint', {
        'es.config.ts': fakeConfig({ harness: '{ delayMs: 60_000 }' }),
        'evals/agent.es.ts': agentEval(''),
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
      assert.equal(r.code, 130, r.stdout + r.stderr)
      const { run, evals } = readRun(p.dir)
      assert.equal(run.status, 'interrupted')
      assert.equal(evals[0]?.outcome, 'fail')
      assert.equal(evals[0]?.error?.kind, 'aborted')
      assert.match(r.stdout, /Cancelled \(1\)\n ✗ evals\/agent\.es\.ts › agent eval/)
      assert.match(r.stdout, /Evals {2}1 cancelled/)
      assert.deepEqual(liveSandboxes(p), [])
    })
  }

  test('Ctrl-C while the worker boots still cancels the attempt before it starts', async () => {
    const p = await project('sigint-early', {
      'es.config.ts': fakeConfig({ harness: '{ delayMs: 60_000 }' }),
      'evals/agent.es.ts': agentEval(''),
    })
    const r = await runCli(p.dir, ['run'], {
      timeoutMs: 20_000,
      onOutput: (stdout, pid) => {
        if (!/^es /m.test(stdout)) return false
        process.kill(pid, 'SIGINT')
        return true
      },
    })
    assert.equal(r.code, 130, r.stdout + r.stderr)
    assert.equal(readRun(p.dir).run.status, 'interrupted')
    assert.deepEqual(liveSandboxes(p), [])
  })
})
