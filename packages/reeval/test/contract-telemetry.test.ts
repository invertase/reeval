// Every harness in the catalog declares, for every telemetry signal, what its record captures
// (test/contract/telemetry.ts), and test/contract/README.md's table is rendered from it.
// REEVAL_UPDATE_SNAPSHOTS=1 rewrites the table.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { AGENTS } from '../src/harness/agents.ts'
import { renderTelemetry, SIGNALS, TELEMETRY } from './contract/telemetry.ts'
import { testDir } from './support/fixture.ts'

const STATES = ['captured', 'partial', 'dropped', 'not-produced']

test('every harness in the catalog declares its telemetry, and only those', () => {
  assert.deepEqual(
    Object.keys(TELEMETRY).sort(),
    Object.keys(AGENTS).sort(),
    'add the harness to TELEMETRY in test/contract/telemetry.ts',
  )
})

test('every harness declares every signal, with a note where the state needs one', () => {
  for (const [kind, row] of Object.entries(TELEMETRY)) {
    assert.deepEqual(
      Object.keys(row).sort(),
      Object.keys(SIGNALS).sort(),
      `${kind}: declare every signal in SIGNALS, and no other`,
    )
    for (const [signal, d] of Object.entries(row)) {
      assert.ok(STATES.includes(d.state), `${kind}.${signal}: unknown state ${d.state}`)
      if (d.state === 'partial') assert.ok(d.note, `${kind}.${signal}: a partial signal says how`)
      if (d.unverified) assert.ok(d.note, `${kind}.${signal}: an unverified signal says why`)
    }
  }
})

test('the README table is current', () => {
  const file = join(testDir, 'contract', 'README.md')
  const readme = readFileSync(file, 'utf8')
  const block =
    /(\[\/\/\]: # \(generated:telemetry\)\n)[\s\S]*?(\[\/\/\]: # \(\/generated:telemetry\))/
  assert.match(readme, block, 'README.md has no generated:telemetry block')
  const next = readme.replace(
    block,
    (_, open, close) => `${open}\n${renderTelemetry(AGENTS)}\n\n${close}`,
  )
  if (process.env.REEVAL_UPDATE_SNAPSHOTS === '1') writeFileSync(file, next)
  else
    assert.equal(
      readme,
      next,
      'test/contract/README.md is stale (REEVAL_UPDATE_SNAPSHOTS=1 rewrites it)',
    )
})
