import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GROK_LOGS_DIR, grokStoredUsageCommand, parseGrokStoredUsage } from '../src/index.ts'

const run = (home: string, since: number) =>
  spawnSync('sh', ['-c', grokStoredUsageCommand({ since })], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })

// The inference lines of a captured Grok Build 1.0.70 log: a turn of 9 calls, then one of 3.
const home = mkdtempSync(join(tmpdir(), 'grok-usage-'))
mkdirSync(join(home, GROK_LOGS_DIR), { recursive: true })
copyFileSync(
  join(import.meta.dirname, 'fixtures/unified-inference.jsonl'),
  join(home, GROK_LOGS_DIR, 'unified.jsonl'),
)

test("the stored usage sums each model call's counts logged since the turn began", () => {
  const out = run(home, Date.parse('2026-11-05T17:59:10.000Z'))
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(parseGrokStoredUsage(out.stdout), {
    calls: 3,
    usage: {
      inputTokens: { total: 83_166, noCache: 990, cacheRead: 82_176, cacheWrite: undefined },
      outputTokens: { total: 151, text: 100, reasoning: 51 },
    },
  })
})

test("the first turn's calls sum to the usage.json Grok wrote at its end", () => {
  const out = run(home, 0)
  const all = JSON.parse(out.stdout) as unknown[]
  const first = parseGrokStoredUsage(JSON.stringify(all.slice(0, 9)))
  assert.deepEqual(first, {
    calls: 9,
    usage: {
      inputTokens: { total: 167_818, noCache: 27_274, cacheRead: 140_544, cacheWrite: undefined },
      outputTokens: { total: 503, text: 368, reasoning: 135 },
    },
  })
})

test('no calls since the turn began, or no log, is no stored usage', () => {
  assert.equal(parseGrokStoredUsage(run(home, Date.parse('2026-11-06')).stdout), undefined)
  const empty = run(mkdtempSync(join(tmpdir(), 'grok-usage-')), 0)
  assert.equal(empty.status, 0, empty.stderr)
  assert.equal(parseGrokStoredUsage(empty.stdout), undefined)
})
