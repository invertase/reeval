// Runs the Go SDK's tests, the conformance goldens among them, and holds its tables to reeval's.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_EGRESS_ALLOW } from '../src/egress.ts'
import { RUNNER_PROTOCOL } from '../src/language-runner/protocol.ts'
import { MATCHERS } from '../src/matchers.ts'
import { testDir } from './support/fixture.ts'

const sdk = join(testDir, '..', '..', '..', 'sdks', 'go')
const source = (file: string) => readFileSync(join(sdk, file), 'utf8')

test('Go SDK tests and conformance goldens', () => {
  const go = spawnSync('go', ['version'], { encoding: 'utf8' })
  if (go.status !== 0)
    assert.fail('Go 1.24 or later is required for the Go SDK tier (https://go.dev/dl)')
  execFileSync('go', ['vet', './...'], { cwd: sdk, stdio: 'inherit' })
  const unformatted = execFileSync('gofmt', ['-l', '.'], { cwd: sdk, encoding: 'utf8' })
  assert.equal(unformatted, '', 'gofmt would change these files')
  execFileSync('go', ['test', '-race', './...'], { cwd: sdk, stdio: 'inherit' })
})

test("the Go SDK's DefaultEgressAllow is reeval's", () => {
  const body = /func DefaultEgressAllow\(\) EgressAllow \{[\s\S]*?\{([^}]*)\}/.exec(
    source('reeval/options.go'),
  )?.[1]
  assert.ok(body, 'DefaultEgressAllow returns a literal in options.go')
  assert.deepEqual(
    [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    [...DEFAULT_EGRESS_ALLOW],
  )
})

test("the Go SDK's matchers are reeval's, each under its Go name", () => {
  const methods = [
    ...source('reeval/expect.go').matchAll(
      /func \(x \*Expectation\) (To\w+)\([\s\S]*?x\.check\("(\w+)"/g,
    ),
  ].map(([, method, matcher]) => [method, matcher] as const)
  assert.deepEqual(
    methods.map(([, matcher]) => matcher),
    Object.keys(MATCHERS),
  )
  for (const [method, matcher] of methods) {
    assert.equal(method.toLowerCase(), matcher.toLowerCase())
  }
})

test("the Go SDK speaks reeval's runner protocol", () => {
  const declared = /const RunnerProtocol = (\d+)/.exec(source('reeval/runner.go'))?.[1]
  assert.equal(Number(declared), RUNNER_PROTOCOL)
})
