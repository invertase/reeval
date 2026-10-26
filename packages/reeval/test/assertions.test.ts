// An attempt's assertion records and end-of-body failure (src/attempt/assertions.ts), from the raw matcher
// calls the engine or the attempt protocol hands it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertionRecords, CAUGHT_HINT, checkFailure } from '../src/attempt/assertions.ts'
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

test('the first call that did not pass fails the attempt: a soft one as what it threw, a caught hard one with the hint', () => {
  const thrown = Object.assign(new Error('expected 1 to be 2'), { name: 'AssertionError' })
  assert.equal(checkFailure([raw({}), raw({ soft: true })]), undefined)
  const caught = checkFailure([raw({}), raw({ status: 'fail', error: thrown })])
  assert.equal(caught?.message, `expected 1 to be 2 ${CAUGHT_HINT}`)
  assert.equal(caught?.name, 'AssertionError')
  assert.equal(thrown.message, 'expected 1 to be 2', "the check's own record keeps its message")
  assert.equal(
    checkFailure([raw({ soft: true }), raw({ soft: true, status: 'fail', error: thrown })]),
    thrown,
  )
  const unanswered = checkFailure([raw({ soft: true, status: 'error', error: 'no turn' })])
  assert.ok(unanswered instanceof Error)
  assert.equal(unanswered.message, 'no turn')
})
