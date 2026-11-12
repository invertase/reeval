import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reclassifyTurnErrors } from '../src/attempt/record.ts'
import type { Attempt } from '../src/attempt/state.ts'
import { isLockfile } from '../src/view/patch.ts'
import { turnErrorKind } from '../src/view/turn-error.ts'

test('isLockfile matches known lockfile basenames', () => {
  assert.equal(isLockfile('pnpm-lock.yaml'), true)
  assert.equal(isLockfile('packages/reeval/package-lock.json'), true)
  assert.equal(isLockfile('src/index.ts'), false)
})

test('turnErrorKind classifies config vs transport', () => {
  assert.equal(turnErrorKind('HTTP 401 unauthorized'), 'config')
  assert.equal(turnErrorKind('model not found'), 'config')
  assert.equal(turnErrorKind('ECONNRESET from upstream'), 'transport')
  assert.equal(turnErrorKind('[unavailable] stream reset'), 'transport')
  assert.equal(turnErrorKind(undefined), 'transport')
})

test('reclassifyTurnErrors moves unhandled turn errors to infra_error', () => {
  const record = {
    outcome: 'fail' as const,
    error: { kind: 'assertion' as const, message: 'check failed' },
    turns: [
      {
        status: 'error' as const,
        transcript: [{ type: 'error' as const, message: 'HTTP 403 forbidden', ts: '', atMs: 0 }],
      },
    ],
  }
  const a = {
    turnStatusRead: false,
    record,
  } as unknown as Attempt
  reclassifyTurnErrors(a)
  assert.equal(record.outcome, 'infra_error')
  assert.equal(record.turnStatusRead, false)
  assert.equal(record.error?.kind, 'infra')
  assert.deepEqual(record.error?.turn, { index: 0, kind: 'config' })
})

test('reclassifyTurnErrors keeps counted outcomes when status was read', () => {
  const record = {
    outcome: 'pass' as const,
    error: null as null,
    turnStatusRead: undefined as boolean | undefined,
    turns: [
      {
        status: 'error' as const,
        transcript: [{ type: 'error' as const, message: 'boom', ts: '', atMs: 0 }],
      },
    ],
  }
  const a = {
    turnStatusRead: true,
    record,
  } as unknown as Attempt
  reclassifyTurnErrors(a)
  assert.equal(record.outcome, 'pass')
  assert.equal(record.turnStatusRead, true)
  assert.equal(record.error, null)
})
