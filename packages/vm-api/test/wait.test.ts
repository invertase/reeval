import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { removeUntilGone, type VmApi, type VmInfo, VmNotReady, waitReady } from '../src/index.ts'

const vm = (raw: string, state: VmInfo['state']): VmInfo => ({
  id: 'bx_1',
  name: 'n',
  state,
  raw,
  labels: {},
})

/** A machine reported as `reports` in turn (the last repeating), null once gone. */
function reporting(reports: Array<VmInfo | null>) {
  const calls: string[] = []
  let i = 0
  const api = {
    async get() {
      calls.push('get')
      return reports[Math.min(i++, reports.length - 1)] ?? null
    },
  } as unknown as VmApi
  return { api, calls }
}

describe('waitReady', () => {
  test('polls until the machine is ready', async () => {
    const { api, calls } = reporting([vm('provisioning', 'starting'), vm('ready', 'ready')])
    assert.equal((await waitReady(api, 'bx_1', { timeoutMs: 5000, pollMs: 1 })).raw, 'ready')
    assert.equal(calls.length, 2)
  })

  test('gives up on a dead machine, one that went and one still starting at the deadline', async () => {
    const dead = { ...vm('error', 'dead'), error: 'no capacity' }
    await assert.rejects(waitReady(reporting([dead]).api, 'bx_1', { timeoutMs: 5000 }), {
      name: 'VmNotReady',
      reason: 'dead',
      message: 'sandbox bx_1 stopped starting: error (no capacity)',
    })
    await assert.rejects(waitReady(reporting([null]).api, 'bx_1', { timeoutMs: 5000 }), {
      reason: 'gone',
    })
    const slow = waitReady(reporting([vm('booting', 'starting')]).api, 'bx_1', {
      timeoutMs: 20,
      pollMs: 5,
    })
    await assert.rejects(slow, (error: unknown) => {
      assert.ok(error instanceof VmNotReady)
      assert.equal(error.reason, 'timeout')
      assert.match(error.message, /still booting/)
      return true
    })
  })
})

describe('removeUntilGone', () => {
  /** A machine the provider keeps provisioning through the first `drops` deletes, then removes. */
  function stuck(drops: number, after: 'gone' | string = 'gone') {
    const calls: string[] = []
    let deletes = 0
    const api = {
      async remove() {
        calls.push('delete')
        deletes++
      },
      async get() {
        calls.push('get')
        if (deletes <= drops) return vm('provisioning', 'starting')
        if (after !== 'gone') return vm(after, 'dead')
        return null
      },
    } as unknown as VmApi
    return { api, calls }
  }
  const quick = { pollMs: 5, redeleteMs: 30 }

  test('sends the delete again until the machine is gone', async () => {
    const { api, calls } = stuck(2)
    assert.equal(await removeUntilGone(api, 'bx_1', { ...quick, deadlineMs: 10_000 }), true)
    assert.equal(calls.filter((c) => c === 'delete').length, 3)
    assert.equal(calls.at(-1), 'get')
  })

  test('stops once the machine is dead', async () => {
    const { api, calls } = stuck(0, 'archived')
    assert.equal(await removeUntilGone(api, 'bx_1', { ...quick, deadlineMs: 10_000 }), true)
    assert.deepEqual(calls, ['delete', 'get'])
  })

  test('sends one delete and stops when already canceled', async () => {
    const { api, calls } = stuck(Number.POSITIVE_INFINITY)
    const canceled = new AbortController()
    canceled.abort()
    assert.equal(await removeUntilGone(api, 'bx_1', { ...quick, signal: canceled.signal }), false)
    assert.deepEqual(calls, ['delete'])
  })

  test('stops polling as soon as it is canceled', async () => {
    const { api, calls } = stuck(Number.POSITIVE_INFINITY)
    const canceled = new AbortController()
    const started = Date.now()
    setTimeout(() => canceled.abort(), 50)
    const options = { pollMs: 60_000, redeleteMs: 60_000, signal: canceled.signal }
    assert.equal(await removeUntilGone(api, 'bx_1', options), false)
    assert.ok(Date.now() - started < 5_000, 'it did not wait out the poll')
    assert.deepEqual(calls, ['delete', 'get'])
  })

  test('gives up after its deadline', async () => {
    const { api } = stuck(Number.POSITIVE_INFINITY)
    const started = Date.now()
    assert.equal(await removeUntilGone(api, 'bx_1', { ...quick, deadlineMs: 100 }), false)
    assert.ok(Date.now() - started < 5_000)
  })
})
