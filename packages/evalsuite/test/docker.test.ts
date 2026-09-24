import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { DEFAULT_IMAGE, HARNESS_CURSOR_VERSION, LABEL } from '../src/sandbox/image.ts'
import { pkgRoot, project, readRun, runCli } from './helpers.ts'

const dockerReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const liveContainers = (runId: string) =>
  execFileSync('docker', ['ps', '-aq', '--filter', `label=${LABEL.run}=${runId}`], {
    encoding: 'utf8',
  }).trim()

const config = (harness: string) => `
import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
import { fakeJudge } from 'evalsuite/judge'
export default defineConfig({
  harness: fakeHarness(${harness}),
  sandbox: docker(),
  judge: { model: fakeJudge() },
})
`

test('the pinned harness version matches the installed adapter', () => {
  const pkg = JSON.parse(readFileSync(`${pkgRoot}/package.json`, 'utf8'))
  assert.equal(pkg.dependencies['@ai-sdk/harness-cursor'], HARNESS_CURSOR_VERSION)
})

describe('docker sandbox', { skip: !dockerReady && `needs Docker and ${DEFAULT_IMAGE}` }, () => {
  test('runs checks in the container, diffs, and removes it', async () => {
    const p = await project('docker-pass', {
      'es.config.ts': config(
        `{ files: { 'greet.js': 'export const greet = (n) => \`Hello, \${n}!\`\\n', 'package.json': '{"type":"module"}' } }`,
      ),
      'evals/d.es.ts': `import { evaluate, expect } from 'evalsuite'
evaluate('docker', async (t) => {
  const turn = await t.send('write greet.js')
  await expect(turn).toHaveFile('greet.js', /Hello/)
  await expect(t.exec('node -e "import(\\'./greet.js\\').then(m => console.log(m.greet(\\'Ada\\')))"')).toSucceed()
  const r = await t.exec('pwd && git --version && ls -A')
  expect(r.stdout).toContain('/es/workspace')
  expect(turn.diff.files).toEqual(expect.arrayContaining([{ path: 'greet.js', status: 'added' }]))
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run, evals } = readRun(p.dir)
    assert.equal(run.stack.images[0]?.ref, DEFAULT_IMAGE)
    assert.match(run.stack.images[0]?.id ?? '', /^sha256:[0-9a-f]{64}$/)
    assert.match(run.stack.images[0]?.agentCli ?? '', /\d/)
    const shown = await runCli(p.dir, ['show', 'latest'])
    assert.match(
      shown.stdout,
      /! Image .+ isn't pushed, so an exact rerun needs this machine's image/,
    )
    assert.ok(
      run.stack.context.some((c) => c.path === '~/.cursor/cli-config.json'),
      JSON.stringify(run.stack.context),
    )
    const log = evals[0]?.read(evals[0].trial.checks[0]?.log.path ?? '') ?? ''
    assert.match(log, /--- stdout\nHello, Ada!\n/)
    assert.equal(liveContainers(run.runId), '')
  })

  test('environment exec steps bake into a cached layer; secrets reach the container', async () => {
    const eval_ = `import { defineEnvironment, evaluate, expect, secret } from 'evalsuite'
const tools = defineEnvironment('tools', (env) => {
  env.exec('echo layer > /opt/es-layer && date +%s%N > /opt/es-built')
  env.file('~/.config/es/hint.txt', 'from home')
})
evaluate('layered', { environment: tools, env: { DB_URL: secret('ES_TEST_DB_URL') } }, async (t) => {
  await t.send('x')
  expect((await t.exec('cat /opt/es-layer')).stdout).toBe('layer\\n')
  expect((await t.exec('printf %s "$DB_URL"')).stdout).toBe('postgres://u:pw-long-enough@db')
  expect((await t.exec('cat ~/.config/es/hint.txt')).stdout).toBe('from home')
  await t.exec('cat /opt/es-built')
})
`
    const p = await project('docker-env', { 'es.config.ts': config('{}'), 'evals/d.es.ts': eval_ })
    const env = { ES_TEST_DB_URL: 'postgres://u:pw-long-enough@db' }
    const first = await runCli(p.dir, ['run'], { env })
    assert.equal(first.code, 0, first.stdout + first.stderr)
    const built = (run: ReturnType<typeof readRun>) =>
      run.evals[0]?.read(run.evals[0].trial.checks[3]?.log.path ?? '') ?? ''
    const a = readRun(p.dir)
    assert.match(a.evals[0]?.trial.image?.ref ?? '', /^evalsuite-env:[0-9a-f]{16}$/)
    assert.deepEqual(a.run.environments[0]?.baked, [
      'echo layer > /opt/es-layer && date +%s%N > /opt/es-built',
    ])
    assert.doesNotMatch(JSON.stringify(a.run), /pw-long-enough/, 'declared secrets are redacted')
    const second = await runCli(p.dir, ['run'], { env })
    assert.equal(second.code, 0, second.stdout + second.stderr)
    const b = readRun(p.dir)
    assert.equal(built(a), built(b), 'the second run reused the cached layer')
    assert.equal(liveContainers(b.run.runId), '')
  })

  test('concurrent attempts in two workers share one build of a new layer', async () => {
    const nonce = `${Date.now()}-${process.pid}`
    const env = `import { defineEnvironment } from 'evalsuite'
export const fresh = defineEnvironment('fresh', (env) => {
  env.exec('echo ${nonce} > /opt/es-nonce && date +%s%N > /opt/es-built')
})
`
    const file = (name: string) => `import { evaluate } from 'evalsuite'
import { fresh } from './env.ts'
evaluate('${name}', { environment: fresh, runs: 2 }, async (t) => {
  await t.send('x')
  await t.exec('cat /opt/es-built')
})
`
    const p = await project('docker-dedupe', {
      'es.config.ts': config('{}'),
      'evals/env.ts': env,
      'evals/a.es.ts': file('a'),
      'evals/b.es.ts': file('b'),
    })
    // BuildKit merges identical builds that overlap, so count ES's `docker build` calls instead.
    const shim = join(p.dir, 'bin')
    const builds = join(p.dir, 'builds.log')
    mkdirSync(shim)
    const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
    writeFileSync(
      join(shim, 'docker'),
      `#!/bin/sh\n[ "$1" = build ] && echo build >> '${builds}'\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    )
    const r = await runCli(p.dir, ['run', '--concurrency', '4'], {
      env: { PATH: `${shim}:${process.env.PATH}` },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const { run, read } = readRun(p.dir)
    const attempts = run.evals.flatMap((e) => e.attempts)
    assert.equal(attempts.length, 4)
    const ids = new Set(attempts.map((a) => a.image?.id))
    const built = new Set(attempts.map((a) => read(a.checks[0]?.log.path ?? '')))
    try {
      assert.equal(readFileSync(builds, 'utf8'), 'build\n', 'one docker build for four attempts')
      assert.equal(ids.size, 1, `one image for every attempt, got ${[...ids].join(', ')}`)
      assert.equal(built.size, 1, 'every attempt saw the same build')
      assert.equal(liveContainers(run.runId), '')
    } finally {
      const refs = new Set(attempts.map((a) => a.image?.ref).filter(Boolean) as string[])
      for (const ref of refs) execFileSync('docker', ['rmi', '-f', ref], { stdio: 'ignore' })
    }
  })

  test('a timeout removes the container', async () => {
    const p = await project('docker-timeout', {
      'es.config.ts': config('{ delayMs: 60_000 }'),
      'evals/d.es.ts': `import { evaluate } from 'evalsuite'
evaluate('slow', { timeout: '3s' }, async (t) => { await t.send('wait') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    const { run, evals } = readRun(p.dir)
    assert.equal(evals[0]?.error?.kind, 'timeout')
    assert.equal(liveContainers(run.runId), '')
  })
})
