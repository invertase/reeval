// daytona({ image | from | dockerfile | install }) without Docker or a key: the Dockerfile reeval
// generates, and preflight's snapshot through every state Daytona reports (one another run is
// building, one a killed run left failed or inactive, a key that can't make snapshots), against
// the fake Daytona API (support/daytona.ts) through the real SDK.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { Daytona } from '@daytona/sdk'
import { NODE_IMAGE } from '../../sandbox-docker/src/build-image.ts'
import { daytonaClient, ensureSnapshot, prepareDaytona } from '../src/sandbox/daytona.ts'
import { daytonaImage, harnessScript } from '../src/sandbox/daytona-image.ts'
import { PrepareError } from '../src/sandbox/provider.ts'
import { daytona } from '../src/sandbox-daytona.ts'
import type { HarnessDescriptor } from '../src/types.ts'
import { type FakeDaytona, fakeDaytona } from './support/daytona.ts'
import type { SshVm } from './support/ssh-vm.ts'

const DIGEST = `sha256:${'a'.repeat(64)}`
const resolve = async (ref: string) =>
  ref.startsWith('private/') ? { error: 'unauthorized' } : { digest: DIGEST }
const fake: HarnessDescriptor = { kind: 'fake', bootstrap: 'echo hi > ~/hello' } as never

/** A machine the fake API reports started, which nothing connects to. */
const idle = async (): Promise<SshVm> => ({
  endpoint: '127.0.0.1:1',
  user: 'root',
  hostKey: '',
  authorize: async () => {},
  allowToken: async () => {},
  remove: async () => {},
})

let failBuilds = false
let api: FakeDaytona
before(async () => {
  api = await fakeDaytona(idle, {
    buildMs: 40,
    build: async () => {
      if (failBuilds) throw new Error('a RUN step exited 1')
    },
  })
})
after(() => api.close())

async function pointedAt<T>(body: () => Promise<T>): Promise<T> {
  const saved = { url: process.env.DAYTONA_API_URL, key: process.env.DAYTONA_API_KEY }
  process.env.DAYTONA_API_URL = api.url
  process.env.DAYTONA_API_KEY = api.key
  try {
    return await body()
  } finally {
    for (const [name, value] of [
      ['DAYTONA_API_URL', saved.url],
      ['DAYTONA_API_KEY', saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

describe('the generated Dockerfile', () => {
  test('bakes the toolchain, the harness as the sandbox user, the install and a home copy on from, pinned', async () => {
    const image = await daytonaImage(
      daytona({ from: 'debian:bookworm-slim', install: ['touch /etc/installed'] }),
      fake,
      { resolve },
    )
    assert.ok(image)
    const lines = image.dockerfile.split('\n')
    assert.equal(lines[0], `FROM debian:bookworm-slim@${DIGEST}`)
    assert.match(image.dockerfile, /apt-get install -y --no-install-recommends bash/)
    const harness = lines.indexOf('USER reeval')
    const install = lines.findIndex((l) => l.includes('/tmp/reeval-install.sh'))
    const copy = lines.findIndex((l) => l.includes('/var/lib/reeval-pool/home-'))
    assert.ok(harness > 0 && install > harness && copy > install, image.dockerfile)
    assert.deepEqual(lines.slice(-4), [
      'USER root',
      'WORKDIR /reeval',
      'ENTRYPOINT ["sleep", "infinity"]',
      '',
    ])
    assert.match(image.name, /^reeval-img-[0-9a-f]{12}$/)
    assert.equal(image.name, `reeval-img-${image.key.slice(0, 12)}`)
    assert.equal(image.harnessBaked, true)
    assert.equal(image.unpinned, undefined)
    assert.match(String(image.homeLabel), /^fake-/)
  })

  test('is keyed on what the base names now, and on the size', async () => {
    const sandbox = daytona({ from: 'debian:bookworm-slim' })
    const a = await daytonaImage(sandbox, fake, { resolve })
    const b = await daytonaImage(sandbox, fake, { resolve })
    const moved = await daytonaImage(sandbox, fake, {
      resolve: async () => ({ digest: `sha256:${'b'.repeat(64)}` }),
    })
    const large = await daytonaImage(
      daytona({ from: 'debian:bookworm-slim', size: 'large' }),
      fake,
      {
        resolve,
      },
    )
    assert.equal(a?.name, b?.name)
    assert.notEqual(a?.name, moved?.name)
    assert.notEqual(a?.name, large?.name)
  })

  test('keys a base the registry refuses on its name, and says so', async () => {
    const image = await daytonaImage(daytona({ from: 'private/toolchain:1' }), fake, { resolve })
    assert.equal(image?.dockerfile.split('\n')[0], 'FROM private/toolchain:1')
    assert.deepEqual(image?.unpinned, { ref: 'private/toolchain:1', reason: 'unauthorized' })
  })

  test("starts a FROM ${REEVAL_BASE} Dockerfile on reeval's base stage, directives first", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reeval-daytona-df-'))
    const path = join(dir, 'Dockerfile')
    writeFileSync(path, '# syntax=docker/dockerfile:1\nFROM ${REEVAL_BASE}\nRUN echo hi\n')
    const image = await daytonaImage({ ...daytona(), dockerfile: path }, fake, { resolve })
    const lines = image?.dockerfile.split('\n') ?? []
    assert.equal(lines[0], '# syntax=docker/dockerfile:1')
    assert.equal(lines[1], `FROM ${NODE_IMAGE} AS reeval-base`)
    assert.ok(lines.includes('FROM reeval-base'), image?.dockerfile)
    assert.ok(!image?.dockerfile.includes('${REEVAL_BASE}'))
    assert.equal(image?.contextDir, dir)
  })

  test('bakes the toolchain and harness onto any other Dockerfile, with no second FROM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reeval-daytona-df-'))
    const path = join(dir, 'Dockerfile')
    writeFileSync(path, 'FROM python:3.12-slim\nRUN pip install ruff\n')
    const image = await daytonaImage({ ...daytona(), dockerfile: path }, fake, { resolve })
    const froms = image?.dockerfile.split('\n').filter((l) => l.startsWith('FROM ')) ?? []
    assert.deepEqual(froms, ['FROM python:3.12-slim'])
    assert.match(String(image?.dockerfile), /RUN pip install ruff\nUSER root\nSHELL/)
    assert.ok(image?.dockerfile.includes('USER reeval'))
  })

  test('uses an image as is, pinned, with nothing baked on', async () => {
    const image = await daytonaImage(daytona({ image: 'acme/agent:1' }), fake, { resolve })
    assert.equal(image?.dockerfile.split('\n')[0], `FROM acme/agent:1@${DIGEST}`)
    assert.ok(!image?.dockerfile.includes('apt-get'))
    assert.ok(!image?.dockerfile.includes('USER reeval'))
    assert.equal(image?.harnessBaked, true)
  })

  test("is none without a recipe: Daytona's default snapshot", async () => {
    assert.equal(await daytonaImage(daytona(), fake, { resolve }), null)
  })

  test("renders a real harness's bootstrap: its files, commands, marker and version probe", async () => {
    const script = String(await harnessScript({ kind: 'cursor' } as HarnessDescriptor))
    assert.match(script, /^set -e\nexport HOME=\/home\/reeval /)
    assert.match(script, /\.ai-sdk-harness\/\.harness-bootstrap\/cursor-sdk/)
    assert.match(script, /\.bootstrap-[0-9a-f]+\.ok/)
    assert.match(script, /bash -c 'sh install\.sh'/)
    assert.match(script, /node -p /)
  })
})

describe("preflight's snapshot", () => {
  const client = () => pointedAt(() => daytonaClient(daytona()))
  const waits = { pollMs: 20, waitMs: 2_000, buildMs: 5_000 }
  const ensure = async (name: string, o: { waits?: typeof waits } = {}) => {
    const log: string[] = []
    const got = await ensureSnapshot((await client()) as Daytona, {
      name,
      image: async () => {
        const { Image } = await import('@daytona/sdk')
        return Image.base('debian:bookworm-slim')
      },
      resources: { cpu: 2, memory: 4, disk: 8 },
      signal: new AbortController().signal,
      log: (line) => log.push(line),
      dockerfileLog: '/tmp/x.Dockerfile',
      waits: o.waits ?? waits,
    })
    return { got, log }
  }
  const posts = (name: string) =>
    api.requests.filter((q) => q.call === 'POST /snapshots' && q.body?.name === name).length

  test('builds a missing one with its resources and returns once active', async () => {
    const { got } = await ensure('t-missing')
    assert.equal(got, 'ready')
    const post = api.requests.findLast((q) => q.call === 'POST /snapshots')?.body
    assert.equal(post?.name, 't-missing')
    assert.deepEqual([post?.cpu, post?.memory, post?.disk], [2, 4, 8])
    assert.match(
      String((post?.buildInfo as { dockerfileContent?: string } | undefined)?.dockerfileContent),
      /^FROM debian:bookworm-slim/,
    )
    assert.equal(api.snapshots().find((s) => s.name === 't-missing')?.state, 'active')
  })

  test('uses an active one as is', async () => {
    api.seedSnapshot('t-active', { state: 'active' })
    assert.equal((await ensure('t-active')).got, 'ready')
    assert.equal(posts('t-active'), 0)
  })

  test('waits on one another run is building, without building it again', async () => {
    api.seedSnapshot('t-pending', {
      state: 'building',
      settle: { afterMs: 150, state: 'active' },
    })
    const { got, log } = await ensure('t-pending')
    assert.equal(got, 'ready')
    assert.equal(posts('t-pending'), 0)
    assert.ok(
      log.some((l) => /waiting for snapshot t-pending, which is building/.test(l)),
      log.join('\n'),
    )
  })

  test('stops waiting after the limit as a transient failure', async () => {
    api.seedSnapshot('t-stuck', { state: 'pulling' })
    const error = await ensure('t-stuck', { waits: { ...waits, waitMs: 100 } }).catch((e) => e)
    assert.ok(error instanceof PrepareError, String(error))
    assert.equal(error.failure.class, 'transient')
    assert.match(error.message, /still pulling after 0 seconds/)
  })

  test("waits between tries when a create finds the name a read doesn't", async () => {
    api.seedSnapshot('t-hidden', { state: 'building', hidden: true })
    const error = await ensure('t-hidden', { waits: { ...waits, waitMs: 100 } }).catch((e) => e)
    assert.ok(error instanceof PrepareError, String(error))
    assert.equal(error.failure.class, 'transient')
    assert.match(error.message, /still being created by another run after 0 seconds/)
    assert.ok(posts('t-hidden') <= 10, `${posts('t-hidden')} creates`)
  })

  test('activates an inactive one', async () => {
    api.seedSnapshot('t-inactive', { state: 'inactive' })
    assert.equal((await ensure('t-inactive')).got, 'ready')
    assert.ok(api.requests.some((q) => /^POST \/snapshots\/[^/]+\/activate$/.test(q.call)))
    assert.equal(posts('t-inactive'), 0)
  })

  test('deletes one a killed run left failed and builds it once more', async () => {
    api.seedSnapshot('t-error', { state: 'error', errorReason: 'the runner went away' })
    const { got, log } = await ensure('t-error')
    assert.equal(got, 'ready')
    assert.equal(posts('t-error'), 1)
    assert.ok(log.some((l) => /is in error \(the runner went away\): deleting it/.test(l)))
  })

  test("fails as config with Daytona's reason and the Dockerfile when the rebuild fails too", async () => {
    api.seedSnapshot('t-broken', { state: 'build_failed', errorReason: 'a RUN step exited 1' })
    failBuilds = true
    try {
      const error = await ensure('t-broken').catch((e) => e)
      assert.ok(error instanceof PrepareError, String(error))
      assert.equal(error.failure.class, 'config')
      assert.equal(error.failure.log, '/tmp/x.Dockerfile')
      assert.match(error.message, /Daytona couldn't build snapshot t-broken: a RUN step exited 1/)
      assert.equal(posts('t-broken'), 1, 'built once more, not again')
    } finally {
      failBuilds = false
    }
  })
})

describe('a key without snapshot permission', () => {
  test('builds the image once in a sandbox that stops idle and is deleted, and every create builds it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reeval-daytona-warm-'))
    const before = api.created().length
    api.refuseSnapshots()
    const log: string[] = []
    const handle = await pointedAt(() =>
      prepareDaytona(daytona({ install: ['touch /etc/installed'], size: 'small' }), fake, {
        root,
        signal: new AbortController().signal,
        log: (line) => log.push(line),
        retry: (step) => step(),
      }),
    )
    const start = handle?.start as { snapshot?: string; dockerfile?: string; name: string }
    assert.equal(start.snapshot, undefined)
    assert.match(String(start.dockerfile), /\/tmp\/reeval-install\.sh/)
    assert.equal(handle?.baked, start.name)
    const [warm, ...more] = api.created().slice(before)
    assert.equal(more.length, 0)
    assert.equal(warm?.autoStopInterval, 15)
    assert.equal(warm?.autoDeleteInterval, 0)
    assert.deepEqual(warm?.resources, { cpu: 1, memory: 1, disk: 3 })
    assert.equal(warm?.dockerfile?.trimEnd(), start.dockerfile?.trimEnd())
    assert.ok(!api.live().includes(String(warm?.name)), 'the warm sandbox is deleted')
    assert.ok(
      log.some((l) => /can't make snapshots/.test(l)),
      log.join('\n'),
    )
    const saved = readFileSync(
      join(root, '.reeval', 'cache', 'images', `${start.name}.Dockerfile`),
      'utf8',
    )
    assert.equal(saved, start.dockerfile)
  })
})
