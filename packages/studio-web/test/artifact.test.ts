import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { missingReason } from '../src/lib/missing-reason.ts'

describe('missingReason', () => {
  test('a recorded path that is not on disk names the usual *.log gitignore', () => {
    assert.equal(
      missingReason({ artifacts: 'all' }, false, true),
      'recorded, but not on disk (often a `*.log` gitignore)',
    )
  })

  test('no file ref still means the run did not write it', () => {
    assert.equal(
      missingReason({ artifacts: 'all' }, false, false),
      "The run didn't write this file.",
    )
  })

  test('artifact flags win over a recorded path', () => {
    assert.match(missingReason({ artifacts: 'all' }, true, true), /--no-artifacts/)
    assert.match(missingReason({ artifacts: 'none' }, false, true), /--artifacts none/)
    assert.match(missingReason({ artifacts: 'failures' }, false, true), /--artifacts failures/)
  })
})
