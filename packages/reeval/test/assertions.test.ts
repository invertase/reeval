// An attempt's assertion records and soft failure (src/attempt/assertions.ts), from the raw matcher
// calls the engine or the attempt protocol hands it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertionRecords, softFailure } from '../src/attempt/assertions.ts'
import type { RawAssertion } from '../src/engine/runtime.ts'

const raw = (over: Partial<RawAssertion>): RawAssertion => ({
  matcher: 'toBe',
  args: [1],
  soft: false,
  status: 'pass',
  ...over,
})

test("a record's message is what the matcher threw, cut at 1 KB", () => {
  const [long, text, empty] = assertionRecords([
    raw({ status: 'fail', error: new Error('x'.repeat(2000)) }),
    raw({ status: 'fail', error: 'plain text' }),
    raw({ label: 'given', status: 'error', error: new TypeError('') }),
  ])
  assert.equal(long?.message, `${'x'.repeat(1024)}…`)
  assert.equal(text?.message, 'plain text')
  assert.deepEqual(empty, {
    label: 'given',
    labelled: true,
    matcher: 'toBe',
    status: 'error',
    soft: false,
    message: '',
  })
})

test("labels are unique within an attempt, even when one given looks like another's #n", () => {
  const labels = (calls: Partial<RawAssertion>[]) =>
    assertionRecords(calls.map(raw)).map((r) => r.label)
  assert.deepEqual(labels([{ label: 'build' }, { label: 'build' }, { label: 'build' }]), [
    'build',
    'build #2',
    'build #3',
  ])
  assert.deepEqual(labels([{ label: 'build' }, { label: 'build' }, { label: 'build #2' }]), [
    'build',
    'build #2',
    'build #2 #2',
  ])
  assert.deepEqual(labels([{ label: 'build #2' }, { label: 'build' }, { label: 'build' }]), [
    'build #2',
    'build',
    'build #3',
  ])
  assert.deepEqual(labels([{}, {}, { label: 'toBe 1 #2' }]), [
    'toBe 1',
    'toBe 1 #2',
    'toBe 1 #2 #2',
  ])
  assert.deepEqual(labels([{ label: 'toBe 1 #2' }, {}, {}, {}]), [
    'toBe 1 #2',
    'toBe 1',
    'toBe 1 #3',
    'toBe 1 #4',
  ])
})

test('the first soft call that did not pass fails the attempt, as what it threw', () => {
  const thrown = new Error('expected 1 to be 2')
  assert.equal(softFailure([raw({}), raw({ status: 'fail', error: thrown })]), undefined)
  assert.equal(
    softFailure([raw({ soft: true }), raw({ soft: true, status: 'fail', error: thrown })]),
    thrown,
  )
  const unanswered = softFailure([raw({ soft: true, status: 'error', error: 'no turn' })])
  assert.ok(unanswered instanceof Error)
  assert.equal(unanswered.message, 'no turn')
})
