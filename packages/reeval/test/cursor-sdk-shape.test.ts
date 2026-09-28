// The stored-conversation fields the Cursor SDK harness recovers web calls from, checked against
// the @cursor/sdk in Cursor's sandbox image (scripts/drift/cursor-sdk-shape.mjs). In the PR
// Docker job that's the pinned SDK; in real.yml's drift leg, the newest one swapped in.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { imageFor } from '@reeval/sandbox-docker'
import { READ_FIELDS, shapeProblems } from '../../../scripts/drift/cursor-sdk-shape.mjs'
import { testDir } from './support/fixture.ts'

const image = imageFor('cursor')
const drift = join(testDir, '../../../scripts/drift')
const built = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const skip =
  built || process.env.REEVAL_TEST_REQUIRE_DOCKER === '1' ? false : `needs Docker and ${image}`

/** A bundle that declares `fields` for each message, as the SDK's dist does. */
const bundle = (fields: Record<string, string[]>) =>
  Object.entries(fields)
    .map(([m, fs]) => `x("${m}|${fs.map((f, i) => `${i + 1} ${f} 9`).join('|')}")`)
    .join(';')

test('the check passes on every read field, and names each one that goes (twins)', () => {
  assert.deepEqual(shapeProblems([bundle(READ_FIELDS)]), [])
  const without = (message: keyof typeof READ_FIELDS, field: string) => ({
    ...READ_FIELDS,
    [message]: READ_FIELDS[message].filter((f) => f !== field),
  })
  assert.deepEqual(shapeProblems([bundle(without('ToolCall', 'started_at_ms'))]), [
    'ToolCall has no started_at_ms',
  ])
  assert.deepEqual(shapeProblems([bundle(without('WebSearchArgs', 'search_term'))]), [
    'WebSearchArgs has no search_term',
  ])
  const { WebFetchToolCall: _, ...rest } = READ_FIELDS
  assert.deepEqual(shapeProblems([bundle(rest)]), ['no WebFetchToolCall message'])
  // A second declaration with every field is enough, as in the SDK (two ToolCall messages).
  assert.deepEqual(
    shapeProblems([bundle(READ_FIELDS), '"ToolCall|1 builtin_tool_call #0 tool_call"']),
    [],
  )
})

test("the image's @cursor/sdk declares every field the runner reads", { skip }, () => {
  const label = execFileSync(
    'docker',
    ['inspect', image, '--format', '{{index .Config.Labels "ai.reeval.agent-version"}}'],
    { encoding: 'utf8' },
  ).trim()
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${drift}:/drift:ro`,
      '--user',
      'es',
      '--entrypoint',
      'bash',
      image,
      '-c',
      'cd ~/.ai-sdk-harness/.harness-bootstrap/cursor-sdk && node /drift/cursor-sdk-shape.mjs',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(r.stdout.trim(), `${label}: every field the runner reads is declared`)
})
