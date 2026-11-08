// The `machines` service the main process answers workers' leases with: one pool per account and
// size across every worker, a released slot handed to the next attempt, a waiting lease
// abandoned, a dead worker's slots broken, pools on one account under its limits, and close
// removing every machine.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { MachineDescriptor } from '../src/sandbox/machine.ts'
import { MachineService, type Pooled, type WireLease } from '../src/sandbox/machine-service.ts'
import type { PoolProvider } from '../src/sandbox/pool.ts'

/** A provider of instant machines, recording what it started and removed, on pools of `machines`. */
function fakePooled(machines = 1) {
  const started: string[] = []
  const removed: string[] = []
  const opened: string[] = []
  const provider: PoolProvider<{ host: string }> = {
    helper: 'fake()',
    async start() {
      const id = `m${started.length + 1}`
      started.push(id)
      return { id, info: { host: `${id}.test` } }
    },
    async remove(id) {
      removed.push(id)
    },
    rateLimited: () => null,
  }
  const pooled: Pooled = {
    key: (s) => (s as MachineDescriptor & { account: string }).account,
    async open(sandbox) {
      opened.push((sandbox as MachineDescriptor & { account: string }).account)
      return {
        provider: provider as PoolProvider<unknown>,
        options: { limits: { machines }, attemptsPerMachine: 1, reuse: true },
      }
    },
  }
  return { pooled, started, removed, opened }
}

const sandbox = (account = 'a') => ({ kind: 'boat', account }) as unknown as MachineDescriptor

const lease = (ticket: string, account = 'a') => ({
  op: 'lease' as const,
  ticket,
  sandbox: sandbox(account),
  runId: 'run',
  root: '/project',
  ttlSeconds: 600,
})

const settled = (p: Promise<unknown>) =>
  Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 30))])

describe('MachineService', () => {
  test("every worker leases from the account's one pool, and a released slot goes to the next", async () => {
    const fake = fakePooled()
    const service = new MachineService({ pooled: () => fake.pooled })
    const first = (await service.call('w1', lease('1'))) as WireLease
    assert.deepEqual(first, {
      info: { host: 'm1.test' },
      machine: 'm1',
      slot: 0,
      reused: 0,
      start: first.start,
      lost: [],
    })
    const second = service.call('w2', lease('1')) as Promise<WireLease>
    assert.equal(await settled(second), 'pending', 'one machine, held by w1')
    await service.call('w1', { op: 'release', ticket: '1', broken: false })
    const next = await second
    assert.equal(next.machine, 'm1')
    assert.equal(next.reused, 1)
    assert.equal(next.start, null)
    const other = (await service.call('w1', lease('2', 'b'))) as WireLease
    assert.equal(other.machine, 'm2', 'another account has its own pool')
    assert.deepEqual(fake.opened, ['a', 'b'])
    await service.close()
    assert.deepEqual(fake.removed.sort(), ['m1', 'm2'])
    await assert.rejects(service.call('w1', lease('3')), /machine pools are closed/)
  })

  test('a worker that exits gives back what it held as broken, and stops what it waited for', async () => {
    const fake = fakePooled()
    const service = new MachineService({ pooled: () => fake.pooled })
    await service.call('w1', lease('1'))
    const waiting = service.call('w1', lease('2'))
    const other = service.call('w2', lease('1')) as Promise<WireLease>
    service.released('w1')
    await assert.rejects(waiting, /worker exited/)
    const next = await other
    assert.equal(next.machine, 'm2', "the dead worker's machine is broken, so a new one starts")
    assert.deepEqual(fake.removed, ['m1'])
    await service.close()
  })

  test('an abandoned lease stops waiting, and one granted after the abandon goes back', async () => {
    const fake = fakePooled()
    const service = new MachineService({ pooled: () => fake.pooled })
    await service.call('w1', lease('1'))
    const waiting = service.call('w2', lease('1'))
    await service.call('w2', { op: 'abandon', ticket: '1' })
    await assert.rejects(waiting, /stopped waiting/)
    await service.call('w1', { op: 'release', ticket: '1', broken: false })
    const next = (await service.call('w3', lease('1'))) as WireLease
    assert.equal(next.machine, 'm1')
    assert.equal(next.reused, 1)
    await service.close()
  })

  test('a kind with no pool, or a pool that fails to open, fails the lease and not the next', async () => {
    let fail = true
    const fake = fakePooled()
    const service = new MachineService({
      pooled: (s) =>
        (s as MachineDescriptor & { account: string }).account === 'none'
          ? undefined
          : {
              ...fake.pooled,
              open: async (...args) => {
                if (fail) throw new Error('no limits')
                return fake.pooled.open(...args)
              },
            },
    })
    await assert.rejects(
      service.call('w', lease('1', 'none')),
      /boat sandboxes have no machine pool/,
    )
    await assert.rejects(service.call('w', lease('2')), /no limits/)
    fail = false
    assert.equal(((await service.call('w', lease('3'))) as WireLease).machine, 'm1')
    assert.deepEqual(Object.keys(await service.stats()), ['run\0a'])
    await service.close()
  })

  test('machines that start from a prepared image pool apart from the base ones', async () => {
    const fake = fakePooled()
    const images: unknown[] = []
    const service = new MachineService({
      pooled: () => ({
        key: (s, image) => `${fake.pooled.key(s)}${image ? `:${image}` : ''}`,
        open: (s, o) => {
          images.push(o.image)
          return fake.pooled.open(s, o)
        },
      }),
    })
    const base = (await service.call('w', lease('1'))) as WireLease
    const saved = (await service.call('w', { ...lease('2'), image: 'img-1' })) as WireLease
    assert.notEqual(saved.machine, base.machine, "the base pool's one machine is held")
    assert.deepEqual(images, [undefined, 'img-1'])
    assert.deepEqual(Object.keys(await service.stats()), ['run\0a', 'run\0a:img-1'])
    await service.close()
  })

  test("the pools of one account share its machines, an idle one making way for another image's", async () => {
    const fake = fakePooled(1)
    const service = new MachineService({
      pooled: () => ({
        key: (s, image) => `${fake.pooled.key(s)}${image ? `:${image}` : ''}`,
        account: (s) => fake.pooled.key(s),
        open: fake.pooled.open,
      }),
    })
    const first = (await service.call('w', { ...lease('1'), image: 'img-1' })) as WireLease
    await service.call('w', { op: 'release', ticket: '1', broken: false })
    const second = (await service.call('w', { ...lease('2'), image: 'img-2' })) as WireLease
    assert.notEqual(second.machine, first.machine)
    assert.deepEqual(fake.removed, [first.machine], "img-1's idle machine went for img-2's")
    const other = (await service.call('w', { ...lease('3', 'b'), image: 'img-1' })) as WireLease
    assert.ok(other.machine, 'another account has room of its own')
    assert.deepEqual(fake.removed, [first.machine])
    await service.close()
  })
})
