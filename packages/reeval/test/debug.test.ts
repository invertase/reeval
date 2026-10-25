// Verbosity and local debug data, through the real CLI on the fake sandbox: the `-v` phase trace
// and `-vv` payloads on screen, debug.log always in .reeval/debug and never in the history folder,
// trace.ndjson kept like a flight recorder (failures, or --trace), redaction in every output,
// retention and `reeval clean`. The Docker phases (image, container, gateway, docker commands) are
// in docker.test.ts.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { debugRoot } from '../src/debug/files.ts'
import { fakeConfig, project, readRun, recordedRuns, runCli } from './helpers.ts'

/** Every file under `dir`, relative to it. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort()
}

/** The one attempt directory of `name` (a substring of its eval slug) in the newest debug run. */
function attemptDir(root: string, name: string): string {
  const runs = readdirSync(debugRoot(root)).sort()
  const run = join(debugRoot(root), runs.at(-1) as string)
  const matches = files(run)
    .filter((f) => f.endsWith('debug.log') && f.includes(name))
    .map((f) => join(run, f.slice(0, -'/debug.log'.length)))
  assert.equal(matches.length, 1, `one attempt of ${name} in ${run}: ${files(run).join(', ')}`)
  return matches[0] as string
}

const read = (path: string) => readFileSync(path, 'utf8')

const script = "{ script: [[{ exec: 'echo from-the-agent' }, { write: { 'out.txt': 'hi\\n' } }]] }"
const passing = `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const env = defineEnvironment('traced', {
  sandbox: fakeSandbox(),
  files: { 'notes.md': 'notes\\n' },
  setup: ['echo set-up > setup.txt'],
})
evaluate('traces every phase', { environment: env }, async (c) => {
  await c.send('write out.txt')
  await expect(c.exec('test -f out.txt')).toSucceed()
  expect(await c.judge('Did it write out.txt?')).toPass()
})
`
const failing = `import { evaluate, expect } from 'reeval'
evaluate('fails its check', async (c) => {
  await c.send('write out.txt')
  expect((await c.exec('test -f missing.txt')).exitCode).toBe(0)
})
`

/** `[traces#1 traced]  12:50:01 <phase>`: one attempt's debug line for a phase. */
const phaseLine = (phase: string, ms = false) =>
  new RegExp(
    `^\\[traces#1 [^\\]]+\\]\\s+\\d{2}:\\d{2}:\\d{2}${ms ? '\\.\\d{3}' : ''} ${phase}\\s`,
    'm',
  )

const PHASES = ['plan', 'env', 'image', 'container', 'harness', 'check', 'judge', 'teardown']

describe('verbosity', () => {
  test('-v prints each phase line for an attempt, prefixed with the attempt', async () => {
    const p = await project('debug-v', {
      'reeval.config.ts': fakeConfig({ harness: script }),
      'evals/a.eval.ts': passing,
    })
    const r = await runCli(p.dir, ['run', '-v'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    for (const phase of PHASES) assert.match(r.stdout, phaseLine(phase), phase)
    // What each phase says: the plan's sources, the files and setup placed, tool calls, the check.
    assert.match(
      r.stdout,
      / plan {6}config reeval\.config\.ts · no profile · run \S+ · attempt fake\/traced\/fake#1$/m,
    )
    assert.match(r.stdout, / plan {6}environment traced \(evaluate\("traces every phase"\)\)$/m)
    assert.match(r.stdout, / env {7}file notes\.md \(6 bytes\)$/m)
    assert.match(r.stdout, / env {7}setup 1\/1 \$ echo set-up > setup\.txt → exit 0 · \d+m?s$/m)
    assert.match(r.stdout, / harness {3}tool shell called: \$ echo from-the-agent$/m)
    assert.match(r.stdout, / check {5}\$ test -f out\.txt → exit 0 · \d+m?s$/m)
    assert.match(r.stdout, / judge {5}fake · \d+m?s · score 0\.90 ≥ 0\.8 · pass · reason: /m)
    assert.match(
      r.stdout,
      / teardown {2}record \.reeval\/runs\/\S+\.json · artifacts .* · debug \.reeval\/debug\//m,
    )
    // -v doesn't print -vv's payloads or millisecond times.
    assert.doesNotMatch(r.stdout, /resolved config|\d{2}:\d{2}:\d{2}\.\d{3}/)
  })

  test('canary: without -v, no phase line prints', async () => {
    const p = await project('debug-quiet', {
      'reeval.config.ts': fakeConfig({ harness: script }),
      'evals/a.eval.ts': passing,
    })
    const r = await runCli(p.dir, ['run', '--output-logs', 'full'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    for (const phase of PHASES) assert.doesNotMatch(r.stdout, phaseLine(phase), phase)
    // Twin: the attempt's own lines still print, under the same prefix.
    assert.match(r.stdout, /^\[traces#1 [^\]]+\] ▶ evals\/a\.eval\.ts › traces every phase$/m)
  })

  test('grouped logs keep each attempt’s debug lines in its own block', async () => {
    const p = await project('debug-grouped', {
      'reeval.config.ts': fakeConfig({ harness: script }),
      'evals/a.eval.ts': passing,
      'evals/b.eval.ts': failing,
    })
    const r = await runCli(p.dir, ['run', '-v', '--log-order', 'grouped'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const lines = r.stdout.split('\n')
    for (const tag of ['[traces#1', '[fails#1']) {
      // Its start line prints at once; everything else is one block when it ends.
      const own = lines.flatMap((l, i) => (l.startsWith(tag) && !l.includes('▶') ? [i] : []))
      const debug = own.filter((i) => / \d{2}:\d{2}:\d{2} [a-z]+ /.test(lines[i] ?? ''))
      assert.ok(debug.length >= PHASES.length - 2, `${tag}: ${debug.length} debug lines`)
      const first = own[0] as number
      assert.deepEqual(
        own,
        own.map((_, i) => first + i),
        `${tag}'s block is contiguous`,
      )
    }
  })

  test('agent mode prints -v lines too, under the attempt tag', async () => {
    const p = await project('debug-agent', {
      'reeval.config.ts': fakeConfig({ harness: script }),
      'evals/a.eval.ts': passing,
    })
    const r = await runCli(p.dir, ['run', '-v'], { env: { REEVAL_UI: 'agent' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    for (const phase of PHASES) assert.match(r.stdout, phaseLine(phase), phase)
    // Twin: agent mode's own output is still there, and nothing else of plain mode's.
    assert.match(r.stdout, /^1 pass$/m)
    assert.doesNotMatch(r.stdout, /▶ evals\/a\.eval\.ts/)
  })

  test('-vv adds raw payloads with millisecond times', async () => {
    const p = await project('debug-vv', {
      'reeval.config.ts': fakeConfig({ harness: script }),
      'evals/a.eval.ts': passing,
    })
    const r = await runCli(p.dir, ['run', '-vv'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    for (const phase of PHASES) assert.match(r.stdout, phaseLine(phase, true), phase)
    assert.match(r.stdout, / plan {6}resolved config\n\[[^\]]+\] {6}\{"config":\{"root":/)
    assert.match(r.stdout, / env {7}resolved environment\n/)
    assert.match(r.stdout, / harness {3}transcript tool\n.*"output":"from-the-agent\\n"/)
    assert.match(r.stdout, / judge {5}judge prompt\n.*"question":"Did it write out\.txt\?"/)
    assert.match(r.stdout, / check {5}check output: test -f out\.txt\n/)
    // --trace is the same level.
    const traced = await runCli(p.dir, ['run', '--trace'])
    assert.match(traced.stdout, / plan {6}resolved config\n/)
  })
})

describe('local debug data', () => {
  test('debug.log is always written to .reeval/debug, and nothing of it lands in the history', async () => {
    const p = await project('debug-log', {
      'reeval.config.ts': fakeConfig({ harness: script }),
      'evals/a.eval.ts': passing,
    })
    const r = await runCli(p.dir, ['run', '--record'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run } = readRun(p.dir)
    const dir = attemptDir(p.dir, 'traces-every-phase')
    assert.ok(dir.includes(join('.reeval', 'debug', run.runId)), dir)
    const log = read(join(dir, 'debug.log'))
    for (const phase of PHASES) {
      assert.match(log, new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z ${phase}\\s`, 'm'), phase)
    }
    assert.deepEqual(files(dir), ['debug.log'], 'a passing attempt keeps no trace')

    const history = join(p.dir, 'evals', '.history')
    assert.deepEqual(recordedRuns(p.dir), [run.runId])
    const recorded = files(history)
    assert.ok(recorded.length > 1, 'twin: the history has the run and its artifacts')
    assert.deepEqual(
      recorded.filter((f) => /debug\.log|trace\.ndjson|requests\.ndjson/.test(f)),
      [],
    )
    for (const f of recorded) {
      assert.doesNotMatch(read(join(history, f)), /\.reeval\/debug|debug\.log/, f)
    }
  })

  test('trace.ndjson is kept for a failing attempt, not a passing one unless --trace', async () => {
    const p = await project('debug-trace', {
      'reeval.config.ts': fakeConfig({ harness: script }),
      'evals/a.eval.ts': passing,
      'evals/b.eval.ts': failing,
    })
    const r = await runCli(p.dir, ['run'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const pass = attemptDir(p.dir, 'traces-every-phase')
    const fail = attemptDir(p.dir, 'fails-its-check')
    assert.equal(existsSync(join(pass, 'trace.ndjson')), false, 'no trace for the pass')
    const trace = read(join(fail, 'trace.ndjson'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.deepEqual(Object.keys(trace[0]), ['kind', 'startedAt', 'limitBytes', 'dropped'])
    assert.equal(trace[0].dropped, 0)
    const kinds = new Set(
      trace.slice(1).map((e: { phase: string; kind: string }) => `${e.phase}/${e.kind}`),
    )
    for (const kind of ['plan/config', 'env/environment', 'harness/transcript', 'check/output']) {
      assert.ok(kinds.has(kind), `${kind} in ${[...kinds].join(', ')}`)
    }
    assert.ok(trace.slice(1).every((e: { ms: unknown }) => Number.isInteger(e.ms)))

    const traced = await runCli(p.dir, ['run', '--trace'])
    assert.equal(traced.code, 1, traced.stdout + traced.stderr)
    assert.ok(existsSync(join(attemptDir(p.dir, 'traces-every-phase'), 'trace.ndjson')))
  })

  test('a small trace buffer drops the oldest entries and says how many', async () => {
    const p = await project('debug-buffer', {
      'reeval.config.ts': fakeConfig({
        harness: script,
        extra: 'debug: { traceBufferMb: 0.002 },',
      }),
      'evals/b.eval.ts': failing,
    })
    const r = await runCli(p.dir, ['run'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    const text = read(join(attemptDir(p.dir, 'fails-its-check'), 'trace.ndjson'))
    const [head, ...entries] = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.ok(head.dropped > 0, JSON.stringify(head))
    assert.ok(text.length < 4 * 2048, `${text.length} bytes`)
    // The newest entries survive: the teardown's.
    assert.equal(entries.at(-1).phase, 'teardown')
  })

  test('redaction holds on screen, in debug.log and in trace.ndjson, encoded forms included', async () => {
    const LEAKY = 'reeval dbg/7c+1d"9a&b?0=e4f'
    const forms = [
      LEAKY,
      Buffer.from(LEAKY).toString('base64'),
      encodeURIComponent(LEAKY),
      JSON.stringify(LEAKY).slice(1, -1),
    ]
    const leak = [
      'echo "$LEAKY"',
      `printf %s "$LEAKY" | base64`,
      `node -e 'console.log(encodeURIComponent(process.env.LEAKY))'`,
    ].join('; ')
    const p = await project('debug-redact', {
      'reeval.config.ts': fakeConfig({
        harness: `{ script: [[{ exec: ${JSON.stringify(leak)} }]] }`,
      })
        .replace('export default defineConfig({', 'export default defineConfig(({ secret }) => ({')
        .replace(/\}\)\n$/, '}))\n')
        .replace('judge:', "env: { LEAKY: secret.fromEnv('REEVAL_DEBUG_LEAKY') },\n  judge:"),
      'evals/b.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('leaks', async (c) => {
  await c.send('print it')
  const r = await c.exec(${JSON.stringify(leak)})
  expect(r.exitCode).toBe(0)
})
`,
    })
    const r = await runCli(p.dir, ['run', '-vv'], { env: { REEVAL_DEBUG_LEAKY: LEAKY } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const dir = attemptDir(p.dir, 'leaks')
    const outputs = {
      screen: r.stdout + r.stderr,
      'debug.log': read(join(dir, 'debug.log')),
      'trace.ndjson': read(join(dir, 'trace.ndjson')),
    }
    for (const [where, text] of Object.entries(outputs)) {
      for (const form of forms) assert.equal(text.includes(form), false, `${where} has ${form}`)
    }
    // The canary: where the secret would be, [REDACTED] is, so the check can see a leak.
    assert.match(outputs.screen, /"output":"\[REDACTED\]\\n\[REDACTED\]\\n\[REDACTED\]\\n"/)
    assert.match(
      outputs['trace.ndjson'],
      /"stdout":"\[REDACTED\]\\n\[REDACTED\]\\n\[REDACTED\]\\n"/,
    )
    assert.match(outputs['debug.log'], /check +\$ echo "\$LEAKY"; .* → exit 0/)
  })

  test("a declared secret under a plain name is masked in an eval's logs and failures on screen", async () => {
    const DSN = 'dsn_7c1d9ab04e4f2a6b8c'
    const p = await project('debug-redact-declared', {
      'reeval.config.ts': fakeConfig(),
      'evals/b.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const env = defineEnvironment('sentry', ({ secret }) => ({
  sandbox: fakeSandbox(),
  env: { SENTRY_DSN: secret.fromEnv('REEVAL_DEBUG_DSN') },
}))
evaluate('prints the dsn', { environment: env }, async (c) => {
  const dsn = (await c.exec('printenv SENTRY_DSN')).stdout.trim()
  console.log('logged', dsn)
  console.error('warned', dsn)
  expect(dsn).toBe('wrong')
})
`,
    })
    for (const ui of ['plain', 'agent']) {
      const r = await runCli(p.dir, ['run', '--ui', ui], { env: { REEVAL_DEBUG_DSN: DSN } })
      assert.equal(r.code, 1, r.stdout + r.stderr)
      const screen = r.stdout + r.stderr
      for (const n of [DSN.length, 12, 8]) {
        assert.equal(
          screen.includes(DSN.slice(-n)),
          false,
          `${ui}: the screen has ${DSN.slice(-n)}`,
        )
      }
      // The canary: the failure is on screen with the value masked, so a leak would show.
      assert.match(screen, /expected '\[REDACTED\]' to be 'wrong'/, `${ui}: ${screen}`)
      if (ui === 'plain') assert.match(screen, /stdout \| logged \[REDACTED\]/)
    }
  })

  test("a secret in an error that stops the run is masked, config's and an eval file's", async () => {
    const KEY = 'reeval-fatal-7c1d9ab04e4f2a6b8c9d0e'
    const p = await project('debug-redact-fatal', {
      'reeval.config.ts': fakeConfig().replace(
        'export default',
        `if (process.env.REEVAL_FATAL_WHERE === 'config') throw new Error('config refused ' + process.env.REEVAL_FATAL_API_KEY)\nexport default`,
      ),
      'evals/b.eval.ts': `import { evaluate } from 'reeval'
if (process.env.REEVAL_FATAL_WHERE === 'eval') throw new Error(\`eval refused \${process.env.REEVAL_FATAL_API_KEY}\`)
evaluate('e', async () => {})
`,
    })
    for (const where of ['config', 'eval']) {
      for (const debug of [{}, { REEVAL_DEBUG: '1' }]) {
        const r = await runCli(p.dir, ['run'], {
          env: { REEVAL_FATAL_WHERE: where, REEVAL_FATAL_API_KEY: KEY, ...debug },
        })
        const screen = r.stdout + r.stderr
        assert.equal(r.code, 2, screen)
        assert.equal(screen.includes(KEY.slice(-12)), false, `${where}: ${screen}`)
        // The canary: the error is on screen, with the key masked where it was.
        assert.match(screen, new RegExp(`${where} refused \\[REDACTED\\]`), screen)
      }
    }
  })

  test("a key's tail is masked on screen, in debug.log, trace.ndjson and the transcript", async () => {
    const KEY = 'crsr_debug_7f3Kq9ZpL2mXw8Rt4VbN6yHc'
    const tail = KEY.slice(-12)
    // What a leak check that searches the sandbox for the key's tail would run and print.
    const search = `echo searching for ${tail}; grep -rlsF -e '${tail}' . || true`
    const p = await project('debug-redact-tail', {
      'reeval.config.ts': fakeConfig({
        harness: `{ script: [[{ exec: ${JSON.stringify(search)} }]] }`,
      }),
      'evals/b.eval.ts': `import { evaluate, expect } from 'reeval'
evaluate('searches for the tail', async (c) => {
  await c.send('search')
  const tail = (process.env.REEVAL_DEBUG_PROVIDER_API_KEY ?? '').slice(-12)
  const r = await c.exec(\`echo searching for \${tail}; grep -rlsF -e '\${tail}' . || true\`)
  expect(r.exitCode).toBe(0)
})
`,
    })
    const env = { REEVAL_DEBUG_PROVIDER_API_KEY: KEY }
    for (const flag of ['-v', '-vv']) {
      const r = await runCli(p.dir, ['run', flag, '--trace'], { env })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      const dir = attemptDir(p.dir, 'searches')
      const { run } = readRun(p.dir)
      const outputs = {
        screen: r.stdout + r.stderr,
        'debug.log': read(join(dir, 'debug.log')),
        'trace.ndjson': read(join(dir, 'trace.ndjson')),
        'the record and transcript': JSON.stringify(run),
      }
      for (const [where, text] of Object.entries(outputs)) {
        for (const n of [8, 10, 12]) {
          const fragment = KEY.slice(-n)
          assert.equal(text.includes(fragment), false, `${flag}: ${where} has the key's last ${n}`)
        }
      }
      // The canary: the masked command is there, so the check would see the tail if it leaked.
      assert.match(outputs['debug.log'], /check +\$ echo searching for \[REDACTED\]; grep/)
      assert.match(outputs['the record and transcript'], /searching for \[REDACTED\]/)
    }
  })

  test('a credential-like MCP header written as a plain string is masked on screen, in the trace and the record', async () => {
    const AUTH = 'Bearer 5c4b3a29f8e7d6c5b4a3928170f6e5d4'
    const SOURCE = 'nightly-ci-9z8y7x6w'
    // The agent prints its MCP config, as a real agent can.
    const config = `Authorization: ${AUTH}\nX-Request-Source: ${SOURCE}\n`
    const p = await project('debug-redact-mcp-header', {
      'reeval.config.ts': fakeConfig({ harness: "{ script: [[{ exec: 'cat mcp-config.txt' }]] }" }),
      'evals/b.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'
const env = defineEnvironment('headers', ({ mcp }) => ({
  sandbox: fakeSandbox(),
  files: { 'mcp-config.txt': ${JSON.stringify(config)} },
  mcp: {
    local: mcp.http('http://localhost:1/mcp', {
      headers: { Authorization: ${JSON.stringify(AUTH)}, 'X-Request-Source': ${JSON.stringify(SOURCE)} },
    }),
  },
}))
evaluate('prints its headers', { environment: env }, async (c) => {
  const turn = await c.send('print them')
  expect(turn.text).toBe('Done.')
})
`,
    })
    const r = await runCli(p.dir, ['run', '-vv', '--trace'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const dir = attemptDir(p.dir, 'prints')
    const view = readRun(p.dir)
    const outputs = {
      screen: r.stdout + r.stderr,
      'debug.log': read(join(dir, 'debug.log')),
      'trace.ndjson': read(join(dir, 'trace.ndjson')),
      'the record and transcript': [
        JSON.stringify(view.run),
        ...files(view.dir).map((f) => read(join(view.dir, f))),
      ].join('\n'),
    }
    for (const [where, text] of Object.entries(outputs)) {
      for (const n of [AUTH.length, 32, 12]) {
        assert.equal(text.includes(AUTH.slice(-n)), false, `${where} has the header's last ${n}`)
      }
    }
    // The canary: the neutral header beside it is printed as it is, so a value would show.
    for (const where of ['screen', 'trace.ndjson', 'the record and transcript'] as const) {
      assert.match(outputs[where], new RegExp(`X-Request-Source: ${SOURCE}`), where)
      assert.match(outputs[where], /Authorization: \[REDACTED\]/, where)
    }
    assert.match(outputs.screen, /mcp\.local\.headers\.Authorization is a plain string/)
    assert.equal(outputs.screen.includes('X-Request-Source is a plain string'), false)
  })

  test('keeps the newest debug.keep runs, and reeval clean clears them', async () => {
    const p = await project('debug-keep', {
      'reeval.config.ts': fakeConfig({ extra: 'debug: { keep: 2 },' }),
      'evals/a.eval.ts': `import { evaluate } from 'reeval'\nevaluate('e', async (c) => { await c.send('go') })\n`,
    })
    const runs = () => (existsSync(debugRoot(p.dir)) ? readdirSync(debugRoot(p.dir)).sort() : [])
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await runCli(p.dir, ['run'])
      assert.equal(r.code, 0, r.stdout + r.stderr)
      ids.push(readRun(p.dir).run.runId)
      assert.equal(runs().length, Math.min(i + 1, 2), `after run ${i + 1}`)
    }
    assert.deepEqual(runs(), ids.slice(1), 'the oldest run went first')

    const some = await runCli(p.dir, ['clean', '--keep', '1'])
    assert.equal(some.code, 0, some.stderr)
    assert.match(
      some.stdout,
      /^Removed debug data for 1 run \(\d+(\.\d)? [KM]?B\) from \.reeval\/debug$/m,
    )
    assert.deepEqual(runs(), ids.slice(2))
    const all = await runCli(p.dir, ['clean'])
    assert.match(all.stdout, /^Removed debug data for 1 run /m)
    assert.deepEqual(runs(), [])
    assert.match(
      (await runCli(p.dir, ['clean'])).stdout,
      /^No debug data to remove in \.reeval\/debug$/m,
    )
    assert.equal(readRun(p.dir).run.runId, ids[2], 'scratch runs are left alone')
    const bad = await runCli(p.dir, ['clean', '--keep', 'x'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /--keep must be a whole number \(got x\)/)
  })
})
