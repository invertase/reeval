import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fakeConfig, liveSandboxes, pkgRoot, project, readResult, runCli } from './helpers.ts'

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
    assert.match(r.stdout, /1 passed · results \.es\/results\/.+\/result\.json/)
    for (const leak of [/vitest/i, /RUN v/, /testTimeout/]) {
      assert.doesNotMatch(r.stdout + r.stderr, leak)
    }
    const result = readResult(p.dir)
    assert.equal(result.schemaVersion, 1)
    assert.deepEqual(result.summary, { passed: 1, failed: 0, infraError: 0, skipped: 0 })
    assert.equal(result.evals[0]?.id, 'evals/math.es.ts › math')
  })

  test('a failing assertion exits 1', async () => {
    const p = await project('fail', { 'es.config.ts': fakeConfig(), 'evals/math.es.ts': math(2) })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /✗ evals\/math\.es\.ts › math/)
    assert.doesNotMatch(r.stdout + r.stderr, /vitest/i)
    const [e] = readResult(p.dir).evals
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
    const evals = readResult(p.dir).evals
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
      readResult(p.dir).evals.map((e) => e.name),
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
    assert.deepEqual(readResult(p.dir).summary, { passed: 1, failed: 0, infraError: 0, skipped: 1 })
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
evaluate('agent eval', ${options ? `${options}, ` : ''}async ({ agent, judge, signal }) => {
  const run = await agent.run('write hello.txt')
  ${body}
})
`

  test('transcript, diff, checks and verdict land in result.json', async () => {
    const big = 'x'.repeat(200_000)
    const p = await project('data-out', {
      'es.config.ts': fakeConfig({
        harness: `{ files: { 'hello.txt': 'hi\\n', 'big.txt': '${big}' }, text: 'Wrote hello.txt' }`,
        judge: `{ fake: { verdict: 'pass', reason: 'hello.txt is in the diff', evidence: ['A hello.txt'] } }`,
      }),
      'evals/agent.es.ts': agentEval(`
  await expect(run).toHaveFile('hello.txt', /hi/)
  await expect(run.exec('cat hello.txt')).toSucceed()
  expect(run.diff.files).toEqual(expect.arrayContaining([{ path: 'hello.txt', status: 'added' }]))
  expect(run.text).toMatch(/hello/)
  expect(await judge(run, 'Did it write hello.txt?')).toPass()
`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /judge {2}pass: "hello\.txt is in the diff"/)

    const [e] = readResult(p.dir).evals
    assert.equal(e?.outcome, 'pass')
    assert.equal(e?.agent?.text, 'Wrote hello.txt')
    assert.equal(e?.agent?.status, 'completed')
    assert.ok(e?.agent?.transcript.some((t) => t.type === 'tool-call'))
    assert.match(e?.diff?.patch ?? '', /\+hi/)
    assert.deepEqual(e?.diff?.files.map((f) => f.path).sort(), ['big.txt', 'hello.txt'])
    assert.deepEqual(e?.checks, [
      { command: 'cat hello.txt', exitCode: 0, stdout: 'hi\n', stderr: '' },
    ])
    assert.equal(e?.judgements[0]?.verdict, 'pass')
    assert.deepEqual(e?.judgements[0]?.evidence, ['A hello.txt'])
    assert.deepEqual(liveSandboxes(p), [], 'sandbox destroyed')
  })

  test('a judge verdict without evidence is inconclusive and fails', async () => {
    const p = await project('inconclusive', {
      'es.config.ts': fakeConfig({
        judge: `{ fake: { verdict: 'pass', reason: 'looks fine', evidence: [] } }`,
      }),
      'evals/agent.es.ts': agentEval(`expect(await judge(run, 'ok?')).toPass()`),
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    assert.match(r.stdout, /judge was inconclusive/)
    const [e] = readResult(p.dir).evals
    assert.equal(e?.judgements[0]?.verdict, 'inconclusive')
    assert.equal(e?.error?.kind, 'judge')
  })

  test('a failing check shows the tail of stderr', async () => {
    const p = await project('check-fail', {
      'es.config.ts': fakeConfig(),
      'evals/agent.es.ts': agentEval(`await expect(run.exec('echo boom >&2; exit 3')).toSucceed()`),
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
    const [e] = readResult(p.dir).evals
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
    const [e] = readResult(p.dir).evals
    assert.equal(e?.outcome, 'fail')
    assert.equal(e?.error?.kind, 'timeout')
    assert.deepEqual(liveSandboxes(p), [])
  })

  test('Ctrl-C mid-turn exits 130, writes result.json and destroys the sandbox', async () => {
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
    const result = readResult(p.dir)
    assert.equal(result.evals[0]?.outcome, 'fail')
    assert.equal(result.evals[0]?.error?.kind, 'aborted')
    assert.match(r.stdout, /✗ evals\/agent\.es\.ts › agent eval {3}cancelled/)
    assert.deepEqual(liveSandboxes(p), [])
  })
})
