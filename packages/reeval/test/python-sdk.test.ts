// Runs the Python SDK's declare conformance tests when uv is available.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { testDir } from './support/fixture.ts'

const pkg = join(testDir, '..', '..', 'reeval-python')

function uv(): string | undefined {
  const r = spawnSync('uv', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  if (r.status === 0) return 'uv'
  return undefined
}

test('Python SDK declare conformance', () => {
  const bin = uv()
  if (!bin) {
    assert.fail('uv is required for the Python SDK tier (install from https://docs.astral.sh/uv/)')
  }
  assert.ok(existsSync(join(pkg, 'pyproject.toml')), 'packages/reeval-python is missing')
  execFileSync(bin, ['sync', '--dev'], { cwd: pkg, stdio: 'pipe' })
  execFileSync(bin, ['run', 'pytest', '-q'], { cwd: pkg, stdio: 'inherit' })
})
