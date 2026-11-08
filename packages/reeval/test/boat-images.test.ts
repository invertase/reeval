// Boat image snapshots through the provider, against the fake Boat API (support/boat.ts) and the
// real SDK. Without Docker its machines are unreachable, which covers finding, waiting on and
// replacing a saved snapshot. With Docker and reeval's image, its machines are SSH VMs whose
// Docker CLI is the host daemon's, so a build runs over SSH from end to end.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, test } from 'node:test'
import { DEFAULT_IMAGE } from '@reeval/sandbox-docker'
import { snapshotName, vmImageKey, vmImageRef } from '../src/sandbox/boat-images.ts'
import type { PrepareContext } from '../src/sandbox/provider.ts'
import { boatProvider } from '../src/sandbox/providers.ts'
import type { ResolveDigest } from '../src/sandbox/recipe.ts'
import { boat } from '../src/sandbox-boat.ts'
import type { HarnessDescriptor } from '../src/types.ts'
import { tempDir } from './helpers.ts'
import { type FakeBoat, fakeBoat, unreachableMachines } from './support/boat.ts'
import { buildSshVmImage, sshVmContainer, startBoatDockerVm } from './support/ssh-vm.ts'

const harness: HarnessDescriptor = { kind: 'fake' }
const DIGEST = `sha256:${'a'.repeat(64)}`
const resolve: ResolveDigest = async (ref) =>
  ref.startsWith('missing') ? { error: `${ref}: not found` } : { digest: DIGEST }
const timings = { pollMs: 10, saveTimeoutMs: 5_000, settleTimeoutMs: 5_000 }
const root = tempDir('boat-images')

const ctx = (): PrepareContext & { lines: string[] } => {
  const lines: string[] = []
  return {
    root,
    signal: AbortSignal.timeout(120_000),
    log: (line) => lines.push(line),
    retry: (step) => step(),
    lines,
  }
}

/** Runs `body` with this process's environment pointed at `on` (the fake API). */
async function pointedAt<T>(on: FakeBoat, body: () => Promise<T>): Promise<T> {
  const saved = { url: process.env.BOAT_BASE_URL, key: process.env.BOAT_API_KEY }
  process.env.BOAT_BASE_URL = on.url
  process.env.BOAT_API_KEY = on.key
  try {
    return await body()
  } finally {
    for (const [name, value] of [
      ['BOAT_BASE_URL', saved.url],
      ['BOAT_API_KEY', saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const builds = (on: FakeBoat) =>
  on.requests.filter(
    (r) => r.call === 'POST /sandboxes' && String(r.body?.name).startsWith('reeval-build-'),
  )

const nameFor = async (recipe: Parameters<typeof vmImageKey>[0]) =>
  snapshotName('reeval', (await vmImageKey(recipe, harness, { root, resolve })).key)

describe('the key a VM image is saved under', () => {
  test('follows what the bases name now, and the recipe', async () => {
    const a = await vmImageKey({ from: 'debian:12' }, harness, { root, resolve })
    assert.equal(a.pinned, true)
    assert.match(a.key, /^[0-9a-f]{64}$/)
    const moved = await vmImageKey({ from: 'debian:12' }, harness, {
      root,
      resolve: async () => ({ digest: `sha256:${'b'.repeat(64)}` }),
    })
    assert.notEqual(moved.key, a.key, 'a moved tag is a new image')
    const more = await vmImageKey({ from: 'debian:12', install: ['true'] }, harness, {
      root,
      resolve,
    })
    assert.notEqual(more.key, a.key)
    assert.notEqual(
      (
        await vmImageKey({ from: 'debian:12' }, { kind: 'claude-code' } as HarnessDescriptor, {
          root,
          resolve,
        })
      ).key,
      a.key,
      "another harness's CLI is another image",
    )
    assert.equal(snapshotName('acme', a.key), `acme-img-${a.key.slice(0, 12)}`)
    assert.equal(vmImageRef(a.key), `reeval-vm-image:${a.key.slice(0, 12)}`)
  })

  test("is the recipe as written when a base doesn't resolve", async () => {
    const a = await vmImageKey({ from: 'missing:1' }, harness, { root, resolve })
    const b = await vmImageKey({ from: 'missing:1' }, harness, { root, resolve })
    assert.equal(a.pinned, false)
    assert.equal(a.key, b.key)
  })

  test("refuses an image its registry doesn't answer for", async () => {
    await assert.rejects(
      vmImageKey({ image: 'missing/local-only:dev' }, harness, { root, resolve }),
      (e: Error & { failure?: { class: string; usage?: boolean } }) =>
        /pulls image missing\/local-only:dev from its registry/.test(e.message) &&
        /use dockerfile/.test(e.message) &&
        e.failure?.class === 'config' &&
        e.failure.usage === true,
    )
    const pinned = await vmImageKey({ image: 'ghcr.io/acme/tools:1' }, harness, { root, resolve })
    assert.equal(pinned.pinned, true)
  })
})

describe('finding a saved snapshot', () => {
  let api: FakeBoat
  before(async () => {
    api = await fakeBoat(unreachableMachines, { savePolls: 2 })
  })
  after(() => api.close())

  test('a sandbox with no recipe builds nothing', async () => {
    const provider = boatProvider({ resolve, timings })
    const before = api.requests.length
    const handle = await pointedAt(api, () => provider.prepare(boat(), harness, ctx()))
    assert.equal(handle, null)
    assert.ok(
      api.requests.slice(before).every((r) => !r.call.includes('snapshot')),
      'no snapshot calls',
    )
  })

  test('uses a ready snapshot without starting a machine', async () => {
    const recipe = { from: 'debian:12' }
    const name = await nameFor(recipe)
    api.snapshots.set(name, {
      name,
      status: 'ready',
      sourceSandboxId: 'bx_other',
      sizeBytes: 123,
      polls: 0,
    })
    const c = ctx()
    const handle = await pointedAt(api, () =>
      boatProvider({ resolve, timings }).prepare({ ...boat(), ...recipe }, harness, c),
    )
    assert.deepEqual(handle, {
      snapshot: name,
      key: (await vmImageKey(recipe, harness, { root, resolve })).key,
      pinned: true,
      imageRef: vmImageRef((await vmImageKey(recipe, harness, { root, resolve })).key),
      imageId: null,
      agentCli: null,
      sizeBytes: 123,
      built: false,
    })
    assert.equal(builds(api).length, 0)
    assert.deepEqual(c.lines, [`Using Boat snapshot ${name}`])
  })

  test('waits on a snapshot another run is saving', async () => {
    const recipe = { from: 'debian:12', install: ['echo saving'] }
    const name = await nameFor(recipe)
    api.snapshots.set(name, { name, status: 'saving', sourceSandboxId: 'bx_other', polls: 3 })
    const handle = (await pointedAt(api, () =>
      boatProvider({ resolve, timings }).prepare({ ...boat(), ...recipe }, harness, ctx()),
    )) as { built: boolean; sizeBytes: number }
    assert.equal(handle.built, false)
    assert.equal(handle.sizeBytes, 400_000_000)
    assert.equal(builds(api).length, 0)
  })

  test('replaces a failed snapshot, on a build VM with snapshots on that goes away', async () => {
    const recipe = { from: 'debian:12', install: ['echo failed'] }
    const name = await nameFor(recipe)
    api.snapshots.set(name, {
      name,
      status: 'failed',
      error: 'disk',
      sourceSandboxId: 'bx_other',
      polls: 0,
    })
    const c = ctx()
    await assert.rejects(
      pointedAt(api, () =>
        boatProvider({ resolve, timings }).prepare({ ...boat(), ...recipe }, harness, c),
      ),
      /can't reach its SSH server/,
    )
    assert.ok(c.lines.some((l) => l.includes('failed to save (disk)')))
    assert.equal(api.snapshots.has(name), false, 'the failed snapshot was deleted')
    const [create] = builds(api)
    assert.equal(create?.body?.snapshots, true)
    assert.equal(create?.body?.noEnv, true)
    assert.match(String(create?.body?.name), /^reeval-build-[0-9a-f]{12}-[0-9a-f]{6}$/)
    assert.deepEqual(api.live(), [], 'the build VM was deleted')
  })

  test('builds one recipe once for every machine size that uses it', async () => {
    const recipe = { from: 'debian:12', install: ['echo once'] }
    const provider = boatProvider({ resolve, timings })
    const before = builds(api).length
    const small = { ...boat(), ...recipe }
    const large = { ...boat({ type: 'default' }), ...recipe }
    assert.notEqual(provider.key(small, harness), provider.key(large, harness))
    assert.notEqual(provider.key(small, harness), provider.key(boat(), harness))
    const results = await pointedAt(api, () =>
      Promise.allSettled([
        provider.prepare(small, harness, ctx()),
        provider.prepare(large, harness, ctx()),
      ]),
    )
    assert.ok(results.every((r) => r.status === 'rejected'))
    assert.equal(builds(api).length - before, 1)
  })
})

const docker = (args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const answers = (args: string[]) => {
  try {
    docker(args)
    return true
  } catch {
    return false
  }
}
const required = process.env.REEVAL_TEST_REQUIRE_DOCKER === '1'
const ready = required || (answers(['info']) && answers(['image', 'inspect', DEFAULT_IMAGE]))

describe('building a snapshot on a VM with Docker', {
  skip: !ready && "Docker isn't running, or reeval's image isn't built",
}, () => {
  let api: FakeBoat
  const made: string[] = []
  before(async () => {
    buildSshVmImage(['boat-docker'])
    api = await fakeBoat(startBoatDockerVm)
  })
  after(async () => {
    await api?.close()
    for (const ref of made) answers(['rm', '-f', ref])
    for (const ref of made) answers(['image', 'rm', '-f', ref])
  })

  test('builds the image over SSH, keeps it in a container and saves the VM', {
    timeout: 300_000,
  }, async () => {
    const marker = `built-${process.pid}-${Date.now()}`
    const recipe = { install: [`echo ${marker} > /tmp/reeval-image`] }
    const { key } = await vmImageKey(recipe, harness, { root, resolve })
    made.push(`reeval-keep-${key.slice(0, 12)}`, vmImageRef(key))
    const c = ctx()
    const handle = (await pointedAt(api, () =>
      boatProvider({ resolve, timings }).prepare({ ...boat(), ...recipe }, harness, c),
    )) as Record<string, unknown>
    const name = snapshotName('reeval', key)
    assert.equal(handle.snapshot, name)
    assert.equal(handle.built, true)
    assert.equal(handle.imageRef, vmImageRef(key))
    assert.match(String(handle.imageId), /^sha256:/)
    assert.equal(handle.sizeBytes, 400_000_000)
    assert.equal(api.snapshots.get(name)?.status, 'ready')
    const build = builds(api).at(-1)
    assert.equal(build?.body?.snapshots, true)
    assert.equal(api.snapshots.get(name)?.sourceName, build?.body?.name)
    // What the VM's Docker holds is the host daemon's here.
    assert.equal(
      docker(['run', '--rm', '--entrypoint', 'cat', vmImageRef(key), '/tmp/reeval-image']),
      marker,
    )
    const keep = docker([
      'container',
      'inspect',
      '--format',
      '{{.Config.Image}} {{index .Config.Labels "reeval.vm-image.key"}}',
      `reeval-keep-${key.slice(0, 12)}`,
    ])
    assert.equal(keep, `${vmImageRef(key)} ${key}`)
    assert.deepEqual(api.live(), [], 'the build VM was deleted')
    assert.equal(sshVmContainer(String(build?.body?.name)), null)
    assert.ok(c.lines.some((l) => l.startsWith(`Saved Boat snapshot ${name} in `)))

    // A later run finds it.
    const again = (await pointedAt(api, () =>
      boatProvider({ resolve, timings }).prepare({ ...boat(), ...recipe }, harness, ctx()),
    )) as Record<string, unknown>
    assert.equal(again.built, false)
    assert.equal(builds(api).length, 1)
  })

  test('a save Boat fails is deleted, and so is the build VM', { timeout: 300_000 }, async () => {
    const recipe = { install: [`echo save-fails-${process.pid}`] }
    const { key } = await vmImageKey(recipe, harness, { root, resolve })
    made.push(`reeval-keep-${key.slice(0, 12)}`, vmImageRef(key))
    api.failSaves(1, 'capture failed')
    await assert.rejects(
      pointedAt(api, () =>
        boatProvider({ resolve, timings }).prepare({ ...boat(), ...recipe }, harness, ctx()),
      ),
      /snapshot reeval-img-[0-9a-f]{12} failed to save: capture failed/,
    )
    assert.equal(api.snapshots.has(snapshotName('reeval', key)), false)
    assert.deepEqual(api.live(), [])
  })
})
