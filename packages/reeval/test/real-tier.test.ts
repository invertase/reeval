import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { baseEnv, pkgRoot } from './helpers.ts'

/** Runs one of the real-agent suites the way CI does, with no provider key in its environment. */
const suite = (file: string, env: NodeJS.ProcessEnv) => {
  const r = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      '--experimental-strip-types',
      '--no-warnings',
      join('test', file),
    ],
    {
      cwd: pkgRoot,
      env: { ...baseEnv, REEVAL_TEST_REQUIRE_DOCKER: '1', ...env },
      encoding: 'utf8',
    },
  )
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('a real-agent tier without its key', () => {
  for (const [file, env] of [
    ['e2e-real.test.ts', { REEVAL_CONTRACT_HARNESSES: 'cursor' }],
    ['contract.test.ts', { REEVAL_CONTRACT_HARNESSES: 'claude-code' }],
    ['features.test.ts', { REEVAL_FIXTURE_TIERS: 'real' }],
  ] as const) {
    test(`${file} fails with REEVAL_TEST_REAL=1, naming the variable; skips without it`, () => {
      const variable = file === 'contract.test.ts' ? 'ANTHROPIC_API_KEY' : 'CURSOR_API_KEY'
      const asked = suite(file, { ...env, REEVAL_TEST_REAL: '1' })
      assert.notEqual(asked.code, 0, asked.out)
      assert.match(asked.out, new RegExp(`${variable} isn't set`))
      assert.doesNotMatch(asked.out, /# SKIP .*isn't set/)

      const local = suite(file, env)
      assert.equal(local.code, 0, local.out)
      assert.match(local.out, /set REEVAL_TEST_REAL=1/)
      assert.match(local.out, /# fail 0/)
    })
  }
})
