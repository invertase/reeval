import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
    assert.equal(run.environment.image?.ref, DEFAULT_IMAGE)
    assert.match(run.environment.image?.id ?? '', /^sha256:[0-9a-f]{64}$/)
    assert.match(run.environment.agentCli ?? '', /\d/)
    const shown = await runCli(p.dir, ['show', 'latest'])
    assert.match(
      shown.stdout,
      /! Image .+ isn't pushed, so an exact rerun needs this machine's image/,
    )
    assert.ok(
      run.environment.context.some((c) => c.path === '~/.cursor/cli-config.json'),
      JSON.stringify(run.environment.context),
    )
    const log = evals[0]?.read(evals[0].trial.checks[0]?.log.path ?? '') ?? ''
    assert.match(log, /--- stdout\nHello, Ada!\n/)
    assert.equal(liveContainers(run.runId), '')
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
