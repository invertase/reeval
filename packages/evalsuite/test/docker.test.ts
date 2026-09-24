import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { DEFAULT_IMAGE, HARNESS_CURSOR_VERSION, LABEL } from '../src/sandbox/image.ts'
import { pkgRoot, project, readResult, runCli } from './helpers.ts'

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
export default defineConfig({
  harness: fakeHarness(${harness}),
  sandbox: docker(),
  judge: { fake: { verdict: 'pass', reason: 'ok', evidence: ['e'] } },
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
evaluate('docker', async ({ agent }) => {
  const run = await agent.run('write greet.js')
  await expect(run).toHaveFile('greet.js', /Hello/)
  await expect(run.exec('node -e "import(\\'./greet.js\\').then(m => console.log(m.greet(\\'Ada\\')))"')).toSucceed()
  const r = await run.exec('pwd && git --version && ls -A')
  expect(r.stdout).toContain('/es/workspace')
  expect(run.diff.files).toEqual(expect.arrayContaining([{ path: 'greet.js', status: 'added' }]))
})
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 0, r.stdout + r.stderr)
    const result = readResult(p.dir)
    assert.equal(result.versions.image, DEFAULT_IMAGE)
    assert.match(result.versions.agentCli ?? '', /\d/)
    assert.equal(result.evals[0]?.checks[0]?.stdout, 'Hello, Ada!\n')
    assert.equal(liveContainers(result.runId), '')
  })

  test('a timeout removes the container', async () => {
    const p = await project('docker-timeout', {
      'es.config.ts': config('{ delayMs: 60_000 }'),
      'evals/d.es.ts': `import { evaluate } from 'evalsuite'
evaluate('slow', { timeout: '3s' }, async ({ agent }) => { await agent.run('wait') })
`,
    })
    const r = await runCli(p.dir)
    assert.equal(r.code, 1)
    const result = readResult(p.dir)
    assert.equal(result.evals[0]?.error?.kind, 'timeout')
    assert.equal(liveContainers(result.runId), '')
  })
})
