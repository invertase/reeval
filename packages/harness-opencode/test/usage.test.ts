import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { OPENCODE_DB, openCodeStoredUsageCommand, parseOpenCodeStoredUsage } from '../src/index.ts'

const run = (home: string, since: number) =>
  spawnSync('sh', ['-c', openCodeStoredUsageCommand({ since })], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })

// A captured OpenCode 2 session's first three assistant messages, in its table's own columns.
const home = mkdtempSync(join(tmpdir(), 'opencode-usage-'))
mkdirSync(dirname(join(home, OPENCODE_DB)), { recursive: true })
const db = new DatabaseSync(join(home, OPENCODE_DB))
db.exec(`CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`)
const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
const rows: [string, number, object][] = [
  ['user', 1_793_901_057_000, { content: [] }],
  [
    'assistant',
    1_793_901_057_105,
    { tokens: { input: 5435, output: 16, reasoning: 252, cache: { read: 0, write: 0 } } },
  ],
  [
    'assistant',
    1_793_901_059_980,
    { tokens: { input: 2432, output: 46, reasoning: 383, cache: { read: 3412, write: 0 } } },
  ],
  [
    'assistant',
    1_793_901_069_820,
    { tokens: { input: 2508, output: 30, reasoning: 81, cache: { read: 3823, write: 0 } } },
  ],
]
rows.forEach(([type, created, data], seq) => {
  insert.run(`m${seq}`, 's', type, seq, created, created, JSON.stringify(data))
})
db.close()

test("the stored usage sums each assistant message's tokens since the turn began", () => {
  const out = run(home, 1_793_901_059_000)
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(parseOpenCodeStoredUsage(out.stdout), {
    calls: 2,
    usage: {
      inputTokens: { total: 12_175, noCache: 4940, cacheRead: 7235, cacheWrite: 0 },
      outputTokens: { total: 540, text: 76, reasoning: 464 },
    },
  })
})

test('no messages since the turn began, or no database, is no stored usage', () => {
  assert.equal(parseOpenCodeStoredUsage(run(home, 1_793_901_070_000).stdout), undefined)
  const empty = run(mkdtempSync(join(tmpdir(), 'opencode-usage-')), 0)
  assert.equal(empty.status, 0, empty.stderr)
  assert.equal(parseOpenCodeStoredUsage(empty.stdout), undefined)
})
