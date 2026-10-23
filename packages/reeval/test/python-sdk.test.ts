// Runs the Python SDK's tests, the conformance goldens through its runner among them.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_EGRESS_ALLOW } from '../src/egress.ts'
import { testDir } from './support/fixture.ts'

const pkg = join(testDir, '..', '..', 'reeval-python')

function uv(): string | undefined {
  const r = spawnSync('uv', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  if (r.status === 0) return 'uv'
  return undefined
}

test('Python SDK tests and conformance goldens', () => {
  const bin = uv()
  if (!bin) {
    assert.fail('uv is required for the Python SDK tier (install from https://docs.astral.sh/uv/)')
  }
  assert.ok(existsSync(join(pkg, 'pyproject.toml')), 'packages/reeval-python is missing')
  execFileSync(bin, ['sync', '--dev'], { cwd: pkg, stdio: 'pipe' })
  execFileSync(bin, ['run', 'pytest', '-q'], { cwd: pkg, stdio: 'inherit' })
})

test("the Python SDK's DEFAULT_EGRESS_ALLOW is reeval's", () => {
  const source = readFileSync(join(pkg, 'src/reeval_python/environment.py'), 'utf8')
  const tuple = /DEFAULT_EGRESS_ALLOW: tuple\[str, \.\.\.\] = \(([^)]*)\)/.exec(source)?.[1]
  assert.ok(tuple, 'DEFAULT_EGRESS_ALLOW is a tuple literal in environment.py')
  const hosts = [...tuple.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(hosts, [...DEFAULT_EGRESS_ALLOW])
})
