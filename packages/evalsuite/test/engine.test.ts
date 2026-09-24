import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fakeConfig, liveSandboxes, pkgRoot, project, readRun, runCli } from './helpers.ts'

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
    assert.match(r.stdout, /Results {2}\.es\/runs\/\d{8}T\d{6}Z_[0-9a-z]+_[a-z0-9-]+\/summary\.md/)
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
      infraError: 0,
      skipped: 0,
    })
    assert.equal(run.evals[0]?.id, 'evals/math.es.ts › math')
    assert.ok(!existsSync(join(p.dir, '.es/results')), 'no legacy result.json')
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
      infraError: 0,
      skipped: 1,
    })
  })

  test('usage errors exit 2', async () => {
    const empty = await project('empty', { 'es.config.ts': fakeConfig() })
    const none = await runCli(empty.dir)
    assert.equal(none.code, 2)
    assert.match(none.stderr, /No evals matched evals\/\*\*\/\*\.es\.ts/)

    assert.equal((await runCli(empty.dir, ['run', '--config', 'missing.ts'])).code, 2)
    assert.equal((await runCli(empty.dir, ['bogus'])).code, 2)
    assert.equal((await runCli(empty.dir, ['--help'])).code, 0)

    const real = await project('creds', {
      'es.config.ts': `import { defineConfig } from 'evalsuite'\nexport default defineConfig({})\n`,
      'evals/math.es.ts': math(1),
    })
    const creds = await runCli(real.dir)
    if (!process.env.CURSOR_API_KEY) {
      assert.equal(creds.code, 2)
      assert.match(creds.stderr, /Missing credentials: CURSOR_API_KEY/)
    }
  })

  test('only the engine module imports vitest', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (
          !path.includes('/src/engine/') &&
          /['"]vitest(\/[^'"]*)?['"]/.test(readFileSync(path, 'utf8'))
        ) {
          offenders.push(path)
        }
      }
    }
    walk(join(pkgRoot, 'src'))
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
        reason: null,
        evidence: [],
      },
    ])
    const [input] = JSON.parse(e.read(e.trial.files.judgeInput?.path ?? ''))
    assert.equal(input.question, 'Did it write hello.txt?')
    assert.equal(input.state.task, 'write hello.txt')
    assert.equal(e.trial.id, 'fake/baseline/fake#1')
    assert.match(
      e.trial.files.diff?.path ?? '',
      new RegExp(`^${e.slug}/fake-baseline-fake-[0-9a-f]{6}/1/diff\\.patch$`),
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
    const out = r.stdout.trimEnd().split('\n')
    assert.equal(out[0], 'es run: 1 eval file')
    assert.match(out[1] ?? '', /^FAIL evals\/agent\.es\.ts › agent eval \(\d+ms, judge\)$/)
    assert.equal(out[2], '  judge  fail 0.30 (≥ 0.8)  ok?')
    assert.match(
      out[3] ?? '',
      /^ {2}record: \.es\/runs\/[^/]+\/evals-agent-es-ts-agent-eval-[0-9a-f]{6}\/1$/,
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

  test('Ctrl-C mid-turn exits 130, records an interrupted run and destroys the sandbox', async () => {
    const p = await project('sigint', {
      'es.config.ts': fakeConfig({ harness: '{ delayMs: 60_000 }' }),
      'evals/agent.es.ts': agentEval(''),
    })
    const r = await runCli(p.dir, ['run'], {
      onSpawn: async (pid) => {
        while (liveSandboxes(p).length === 0) await sleep(50)
        process.kill(-pid, 'SIGINT') // the whole process group, like a terminal
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
})
