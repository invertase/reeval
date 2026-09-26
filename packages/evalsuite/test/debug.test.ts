// Verbosity and local debug data, through the real CLI on the fake sandbox: the `-v` phase trace
// and `-vv` payloads on screen, debug.log always in .es/debug and never in the history folder,
// trace.ndjson kept like a flight recorder (failures, or --trace), redaction in every output,
// retention and `es clean`. The Docker phases (image, container, gateway, docker commands) are
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
const passing = `import { defineEnvironment, evaluate, expect } from 'evalsuite'
const env = defineEnvironment('traced', {
  files: { 'notes.md': 'notes\\n' },
  setup: ['echo set-up > setup.txt'],
})
evaluate('traces every phase', { environment: env }, async (t) => {
  await t.send('write out.txt')
  await expect(t.exec('test -f out.txt')).toSucceed()
  expect(await t.judge('Did it write out.txt?')).toPass()
})
`
const failing = `import { evaluate, expect } from 'evalsuite'
evaluate('fails its check', async (t) => {
  await t.send('write out.txt')
  expect((await t.exec('test -f missing.txt')).exitCode).toBe(0)
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
      'es.config.ts': fakeConfig({ harness: script }),
      'evals/a.es.ts': passing,
    })
    const r = await runCli(p.dir, ['run', '-v'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    for (const phase of PHASES) assert.match(r.stdout, phaseLine(phase), phase)
    // What each phase says: the plan's sources, the files and setup placed, tool calls, the check.
    assert.match(
      r.stdout,
      / plan {6}config es\.config\.ts · no profile · run \S+ · attempt fake\/traced\/fake#1$/m,
    )
    assert.match(r.stdout, / plan {6}environment traced \(evaluate\("traces every phase"\)\)$/m)
    assert.match(r.stdout, / env {7}file notes\.md \(6 bytes\)$/m)
    assert.match(r.stdout, / env {7}setup 1\/1 \$ echo set-up > setup\.txt → exit 0 · \d+ms$/m)
    assert.match(r.stdout, / harness {3}tool shell called: \$ echo from-the-agent$/m)
    assert.match(r.stdout, / check {5}\$ test -f out\.txt → exit 0 · \d+ms$/m)
    assert.match(r.stdout, / judge {5}fake · \d+ms · score 0\.90 ≥ 0\.8 · pass · reason: /m)
    assert.match(
      r.stdout,
      / teardown {2}record \.es\/runs\/\S+\.json · artifacts .* · debug \.es\/debug\//m,
    )
    // -v doesn't print -vv's payloads or millisecond times.
    assert.doesNotMatch(r.stdout, /resolved config|\d{2}:\d{2}:\d{2}\.\d{3}/)
  })

  test('canary: without -v, no phase line prints', async () => {
    const p = await project('debug-quiet', {
      'es.config.ts': fakeConfig({ harness: script }),
      'evals/a.es.ts': passing,
    })
    const r = await runCli(p.dir, ['run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    for (const phase of PHASES) assert.doesNotMatch(r.stdout, phaseLine(phase), phase)
    // Twin: the attempt's own lines still print, under the same prefix.
    assert.match(r.stdout, /^\[traces#1 [^\]]+\] ✓ evals\/a\.es\.ts › traces every phase/m)
  })

  test('grouped logs keep each attempt’s debug lines in its own block', async () => {
    const p = await project('debug-grouped', {
      'es.config.ts': fakeConfig({ harness: script }),
      'evals/a.es.ts': passing,
      'evals/b.es.ts': failing,
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
      'es.config.ts': fakeConfig({ harness: script }),
      'evals/a.es.ts': passing,
    })
    const r = await runCli(p.dir, ['run', '-v'], { env: { ES_UI: 'agent' } })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    for (const phase of PHASES) assert.match(r.stdout, phaseLine(phase), phase)
    // Twin: agent mode's own output is still there, and nothing else of plain mode's.
    assert.match(r.stdout, /^1 passed$/m)
    assert.doesNotMatch(r.stdout, /✓ evals\/a\.es\.ts/)
  })

  test('-vv adds raw payloads with millisecond times', async () => {
    const p = await project('debug-vv', {
      'es.config.ts': fakeConfig({ harness: script }),
      'evals/a.es.ts': passing,
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
  test('debug.log is always written to .es/debug, and nothing of it lands in the history', async () => {
    const p = await project('debug-log', {
      'es.config.ts': fakeConfig({ harness: script }),
      'evals/a.es.ts': passing,
    })
    const r = await runCli(p.dir, ['run', '--record'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run } = readRun(p.dir)
    const dir = attemptDir(p.dir, 'traces-every-phase')
    assert.ok(dir.includes(join('.es', 'debug', run.runId)), dir)
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
      assert.doesNotMatch(read(join(history, f)), /\.es\/debug|debug\.log/, f)
    }
  })

  test('trace.ndjson is kept for a failing attempt, not a passing one unless --trace', async () => {
    const p = await project('debug-trace', {
      'es.config.ts': fakeConfig({ harness: script }),
      'evals/a.es.ts': passing,
      'evals/b.es.ts': failing,
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
      'es.config.ts': fakeConfig({ harness: script, extra: 'debug: { traceBufferMb: 0.002 },' }),
      'evals/b.es.ts': failing,
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
    const LEAKY = 'es dbg/7c+1d"9a&b?0=e4f2'
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
      'es.config.ts': fakeConfig({
        harness: `{ script: [[{ exec: ${JSON.stringify(leak)} }]] }`,
      })
        .replace('export default defineConfig({', 'export default defineConfig(({ secret }) => ({')
        .replace(/\}\)\n$/, '}))\n')
        .replace('judge:', "env: { LEAKY: secret.fromEnv('ES_DEBUG_LEAKY') },\n  judge:"),
      'evals/b.es.ts': `import { evaluate, expect } from 'evalsuite'
evaluate('leaks', async (t) => {
  await t.send('print it')
  const r = await t.exec(${JSON.stringify(leak)})
  expect(r.exitCode).toBe(0)
})
`,
    })
    const r = await runCli(p.dir, ['run', '-vv'], { env: { ES_DEBUG_LEAKY: LEAKY } })
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

  test("a key's tail is masked on screen, in debug.log, trace.ndjson and the transcript", async () => {
    const KEY = 'crsr_debug_7f3Kq9ZpL2mXw8Rt4VbN6yHc'
    const tail = KEY.slice(-12)
    // What a leak check that searches the sandbox for the key's tail would run and print.
    const search = `echo searching for ${tail}; grep -rlsF -e '${tail}' . || true`
    const p = await project('debug-redact-tail', {
      'es.config.ts': fakeConfig({
        harness: `{ script: [[{ exec: ${JSON.stringify(search)} }]] }`,
      }),
      'evals/b.es.ts': `import { evaluate, expect } from 'evalsuite'
evaluate('searches for the tail', async (t) => {
  await t.send('search')
  const tail = (process.env.ES_DEBUG_PROVIDER_API_KEY ?? '').slice(-12)
  const r = await t.exec(\`echo searching for \${tail}; grep -rlsF -e '\${tail}' . || true\`)
  expect(r.exitCode).toBe(0)
})
`,
    })
    const env = { ES_DEBUG_PROVIDER_API_KEY: KEY }
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

  test('keeps the newest debug.keep runs, and es clean clears them', async () => {
    const p = await project('debug-keep', {
      'es.config.ts': fakeConfig({ extra: 'debug: { keep: 2 },' }),
      'evals/a.es.ts': `import { evaluate } from 'evalsuite'\nevaluate('e', async (t) => { await t.send('go') })\n`,
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
      /^Removed debug data for 1 run \(\d+(\.\d)? [KM]?B\) from \.es\/debug$/m,
    )
    assert.deepEqual(runs(), ids.slice(2))
    const all = await runCli(p.dir, ['clean'])
    assert.match(all.stdout, /^Removed debug data for 1 run /m)
    assert.deepEqual(runs(), [])
    assert.match(
      (await runCli(p.dir, ['clean'])).stdout,
      /^No debug data to remove in \.es\/debug$/m,
    )
    assert.equal(readRun(p.dir).run.runId, ids[2], 'scratch runs are left alone')
    const bad = await runCli(p.dir, ['clean', '--keep', 'x'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /--keep must be a whole number \(got x\)/)
  })
})
