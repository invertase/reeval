// Runs the Python SDK's declare conformance tests when python3 is available.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { testDir } from './support/fixture.ts'

const pkg = join(testDir, '..', '..', 'reeval-python')

function python(): string | undefined {
  const candidates = ['python3', 'python']
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    if (r.status === 0) return bin
  }
  return undefined
}

test('Python SDK declare conformance', () => {
  const py = python()
  if (!py) {
    assert.fail('python3 is required for the Python SDK tier (install Python 3.11+)')
  }
  assert.ok(existsSync(join(pkg, 'pyproject.toml')), 'packages/reeval-python is missing')
  execFileSync(py, ['-m', 'pip', 'install', '-e', `${pkg}[dev]`], {
    cwd: pkg,
    stdio: 'pipe',
  })
  execFileSync(py, ['-m', 'pytest', '-q'], { cwd: pkg, stdio: 'inherit' })
})
