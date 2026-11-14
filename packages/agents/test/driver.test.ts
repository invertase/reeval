// startAgent's start: every way it can fail is the one AgentError, with the caller's onClose run.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HARNESSES } from '../src/catalog/index.ts'
import { startAgent } from '../src/driver/agent.ts'
import { AgentError } from '../src/errors.ts'
import type { Runner } from '../src/runner.ts'

const adapter = {
  specificationVersion: 'harness-v1',
  harnessId: 'probe',
  builtinTools: {},
  doStart: () => Promise.reject(new Error('unreachable')),
} as never

function start(info: () => Promise<never>) {
  const closed: string[] = []
  const runner = {
    info,
    spawn: () => assert.fail('nothing runs before the session starts'),
  } as unknown as Runner
  const started = startAgent({
    kind: 'codex',
    entry: HARNESSES.codex,
    adapter,
    model: 'm',
    runner,
    workDir: 'workspace',
    signal: new AbortController().signal,
    log: { log: () => {}, trace: () => {} },
    onClose: () => void closed.push('closed'),
  })
  return { started, closed }
}

test('a runner whose info fails fails the start as an AgentError, and runs onClose', async () => {
  const { started, closed } = start(() => Promise.reject(new Error('uname: exec failed')))
  await assert.rejects(started, (error) => {
    assert.ok(error instanceof AgentError)
    assert.equal(error.message, 'Codex harness failed to start: uname: exec failed')
    assert.equal(error.transient, false)
    return true
  })
  assert.deepEqual(closed, ['closed'])
})

test('a transient info failure is a transient start failure', async () => {
  const { started } = start(() =>
    Promise.reject(Object.assign(new Error('connection reset'), { transient: true })),
  )
  await assert.rejects(started, (error) => error instanceof AgentError && error.transient)
})
