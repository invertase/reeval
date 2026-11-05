import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codexStoredUsageCommand, parseCodexStoredUsage } from '../src/codex-usage.ts'

const run = (home: string, since: number) =>
  spawnSync('sh', ['-c', codexStoredUsageCommand({ since })], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })

// The token_count events of a captured Codex 0.164 rollout: 11 calls, and one with no counts.
const home = mkdtempSync(join(tmpdir(), 'codex-usage-'))
const day = join(home, '.codex/sessions/2026/11/05')
mkdirSync(day, { recursive: true })
copyFileSync(
  join(import.meta.dirname, 'fixtures/rollout-token-counts.jsonl'),
  join(day, 'rollout-2026-11-05T17-39-17-01a1accb.jsonl'),
)

test("the stored usage sums each model call's counts in the rollout since the turn began", () => {
  const out = run(home, Date.parse('2026-11-05T17:39:43.000Z'))
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(parseCodexStoredUsage(out.stdout), {
    calls: 5,
    usage: {
      inputTokens: { total: 116_749, noCache: 15, cacheRead: 101_399, cacheWrite: 15_335 },
      outputTokens: { total: 338, text: 218, reasoning: 120 },
    },
  })
})

test('the stored usage of every call equals the total Codex keeps for the thread', () => {
  const read = parseCodexStoredUsage(run(home, 0).stdout)
  assert.equal(read?.calls, 11)
  assert.equal(read?.usage.inputTokens.total, 186_895)
  assert.equal(read?.usage.outputTokens.total, 953)
})

test('no calls since the turn began, or no rollouts, is no stored usage', () => {
  assert.equal(parseCodexStoredUsage(run(home, Date.parse('2026-11-06')).stdout), undefined)
  const empty = run(mkdtempSync(join(tmpdir(), 'codex-usage-')), 0)
  assert.equal(empty.status, 0, empty.stderr)
  assert.equal(parseCodexStoredUsage(empty.stdout), undefined)
  assert.equal(parseCodexStoredUsage('not json'), undefined)
})
