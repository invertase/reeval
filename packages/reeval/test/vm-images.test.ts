// `reeval image build`, `list` and `clean` on boat() and daytona() image snapshots, against the
// fake Boat and Daytona APIs (support/boat.ts, support/daytona.ts) through the real SDKs, with no
// key, Docker or network: each recipe is a Dockerfile whose base is a build argument, so its key
// looks up no registry.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  ago,
  cleanChoices,
  parseAge,
  RECENT_MS,
  type VmSnapshot,
} from '../src/sandbox/vm-images.ts'
import { project, runCli } from './helpers.ts'
import { type FakeBoat, fakeBoat, unreachableMachines } from './support/boat.ts'
import { type FakeDaytona, fakeDaytona } from './support/daytona.ts'
import type { SshVm } from './support/ssh-vm.ts'

const DAY = 86_400_000
const now = Date.UTC(2026, 10, 8)

const snap = (name: string, o: Partial<VmSnapshot> = {}): VmSnapshot => ({
  provider: 'boat',
  account: 'BOAT_API_KEY',
  prefix: 'reeval',
  name,
  status: 'ready',
  sizeBytes: null,
  createdAt: now - 30 * DAY,
  lastUsedAt: null,
  ...o,
})

describe('which snapshots clean deletes', () => {
  test('keeps one this machine just used, one being saved, and one an environment uses', () => {
    const choices = cleanChoices(
      [
        snap('reeval-img-recent'),
        snap('reeval-img-saving', { status: 'saving' }),
        snap('reeval-img-used'),
        snap('reeval-img-old'),
        snap('reeval-img-fresh', { createdAt: now - 2 * DAY }),
        snap('reeval-img-elsewhere', { provider: 'daytona', lastUsedAt: now - 60_000 }),
        snap('reeval-img-snapshotting', { provider: 'daytona', status: 'snapshotting' }),
        snap('reeval-img-unknown', { status: 'unknown' }),
      ],
      {
        cache: new Map([
          [
            'boat\0BOAT_API_KEY\0reeval-img-recent',
            {
              provider: 'boat',
              account: 'BOAT_API_KEY',
              name: 'reeval-img-recent',
              key: 'k',
              lastUsedAt: now - RECENT_MS / 2,
            },
          ],
        ]),
        usedBy: new Map([['reeval-img-used', ['boat · fake']]]),
        now,
        olderThanMs: 14 * DAY,
      },
    )
    assert.deepEqual(
      choices.map((c) => [c.snapshot.name, c.keep]),
      [
        ['reeval-img-recent', 'used in the last hour'],
        ['reeval-img-saving', 'still saving'],
        ['reeval-img-used', 'used by boat · fake'],
        ['reeval-img-old', null],
        ['reeval-img-fresh', 'used more recently'],
        ['reeval-img-elsewhere', 'used in the last hour'],
        ['reeval-img-snapshotting', 'still snapshotting'],
        ['reeval-img-unknown', 'still unknown'],
      ],
    )
  })

  test('--all deletes one an environment uses, never one just used or being saved', () => {
    const choices = cleanChoices([snap('reeval-img-used'), snap('a', { status: 'saving' })], {
      cache: new Map(),
      usedBy: new Map([['reeval-img-used', ['x']]]),
      now,
      all: true,
    })
    assert.deepEqual(
      choices.map((c) => c.keep),
      [null, 'still saving'],
    )
  })

  test('--older-than takes minutes, hours and days', () => {
    assert.equal(parseAge('14d'), 14 * DAY)
    assert.equal(parseAge('12h'), 12 * 3_600_000)
    assert.equal(parseAge('30m'), 30 * 60_000)
    for (const bad of ['14', '0d', 'two weeks', '-1d']) {
      assert.throws(() => parseAge(bad), /--older-than takes a duration such as 14d/)
    }
    assert.equal(ago(null, now), '-')
    assert.equal(ago(now - 3 * DAY, now), '3d ago')
  })
})

/** A machine the fake API reports started, which nothing connects to. */
const idle = async (): Promise<SshVm> => ({
  endpoint: '127.0.0.1:1',
  user: 'root',
  hostKey: '',
  authorize: async () => {},
  allowToken: async () => {},
  remove: async () => {},
})

/** A host cache of its own, so this machine's record of each snapshot's use starts empty. */
const hostCache = () => mkdtempSync(join(tmpdir(), 'reeval-vm-cache-'))

const files = (sandbox: string, imports: string) => ({
  'reeval.config.ts': `
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
${imports}
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'true' }]] }),
  sandbox: ${sandbox},
  egress: 'allow-all',
})
`,
  'image/Dockerfile': 'ARG BASE=debian:12\nFROM $BASE\nRUN true\n',
  'evals/a.eval.ts': `
import { evaluate } from 'reeval'
evaluate('a', async (c) => {
  await c.exec('true')
})
`,
})

describe('reeval image on daytona()', () => {
  let api: FakeDaytona
  before(async () => {
    api = await fakeDaytona(idle, { buildMs: 30 })
  })
  after(() => api.close())

  test('builds the snapshot, lists it, and clean keeps it while an environment uses it', async () => {
    const p = await project(
      'vm-images-daytona',
      files(
        "daytona({ dockerfile: './image/Dockerfile' })",
        "import { daytona } from 'reeval/sandbox/daytona'",
      ),
    )
    const cacheHome = hostCache()
    const env = { DAYTONA_API_URL: api.url, DAYTONA_API_KEY: api.key, XDG_CACHE_HOME: cacheHome }
    const cli = (args: string[]) => runCli(p.dir, args, { env, timeoutMs: 90_000 })
    const names = () =>
      api
        .snapshots()
        .filter((s) => s.state !== 'removing')
        .map((s) => s.name)
        .sort()

    const plan = await cli(['image', 'build', '--dry-run'])
    assert.equal(plan.code, 0, plan.stdout + plan.stderr)
    const name = /\+ .* (reeval-img-[0-9a-f]{12}) {2}\(to build\)/.exec(plan.stdout)?.[1]
    assert.ok(name, plan.stdout)
    assert.deepEqual(names(), [], 'a dry run builds nothing')

    const built = await cli(['image', 'build'])
    assert.equal(built.code, 0, built.stdout + built.stderr)
    assert.match(built.stdout, new RegExp(`✓ daytona.*: snapshot ${name} built in`))
    assert.equal(api.snapshots().find((s) => s.name === name)?.state, 'active')

    const again = await cli(['image', 'build'])
    assert.match(again.stdout, new RegExp(`✓ daytona.*: snapshot ${name} saved`))

    api.seedSnapshot('reeval-img-000000000000', {
      state: 'active',
      size: 1.5,
      createdAt: new Date(Date.now() - 30 * DAY).toISOString(),
    })
    api.seedSnapshot('reeval-img-111111111111', {
      state: 'active',
      createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
    })
    api.seedSnapshot('reeval-img-222222222222', {
      state: 'snapshotting',
      createdAt: new Date(Date.now() - 30 * DAY).toISOString(),
    })
    api.seedSnapshot('reeval-img-mine', { state: 'active' })
    api.seedSnapshot('someone-else', { state: 'active' })
    const list = await cli(['image', 'list', '--json'])
    assert.equal(list.code, 0, list.stdout + list.stderr)
    const listed = JSON.parse(list.stdout) as {
      snapshots: Array<{ name: string; usedBy: string[]; sizeBytes: number | null }>
    }
    assert.deepEqual(
      listed.snapshots.map((s) => s.name).sort(),
      [
        'reeval-img-000000000000',
        'reeval-img-111111111111',
        'reeval-img-222222222222',
        name,
      ].sort(),
    )
    assert.equal(listed.snapshots.find((s) => s.name === name)?.usedBy.length, 1)
    assert.equal(
      listed.snapshots.find((s) => s.name === 'reeval-img-000000000000')?.sizeBytes,
      1.5 * 1024 ** 3,
    )

    const dry = await cli(['image', 'clean', '--dry-run'])
    assert.equal(dry.code, 0, dry.stdout + dry.stderr)
    assert.match(dry.stdout, /would delete daytona reeval-img-000000000000 \(1\.6 GB\)/)
    assert.match(dry.stdout, new RegExp(`kept daytona ${name}: used in the last hour`))
    assert.match(dry.stdout, /kept daytona reeval-img-111111111111: used more recently/)
    assert.match(dry.stdout, /kept daytona reeval-img-222222222222: still snapshotting/)
    assert.equal(names().length, 6, 'a dry run deletes nothing')

    const cleaned = await cli(['image', 'clean'])
    assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr)
    assert.match(cleaned.stdout, /✓ deleted daytona reeval-img-000000000000/)
    assert.deepEqual(
      names(),
      [
        'reeval-img-111111111111',
        'reeval-img-222222222222',
        name,
        'reeval-img-mine',
        'someone-else',
      ].sort(),
    )
    const younger = await cli(['image', 'clean', '--older-than', '1d'])
    assert.equal(younger.code, 0, younger.stdout + younger.stderr)
    assert.match(younger.stdout, /✓ deleted daytona reeval-img-111111111111/)

    const cache = join(cacheHome, 'reeval', 'vm-images.json')
    const doc = JSON.parse(readFileSync(cache, 'utf8')) as { images: { lastUsedAt: number }[] }
    for (const e of doc.images) e.lastUsedAt = Date.now() - 2 * RECENT_MS
    writeFileSync(cache, JSON.stringify(doc))
    const inUse = await cli(['image', 'clean'])
    assert.match(inUse.stdout, new RegExp(`kept daytona ${name}: used by daytona`))
    const all = await cli(['image', 'clean', '--all', '--provider', 'daytona'])
    assert.equal(all.code, 0, all.stdout + all.stderr)
    assert.deepEqual(names(), ['reeval-img-222222222222', 'reeval-img-mine', 'someone-else'])
  })
})

describe('reeval image on boat()', () => {
  let api: FakeBoat
  before(async () => {
    api = await fakeBoat(unreachableMachines)
  })
  after(() => api.close())

  test('uses a saved snapshot, and refuses a provider it has no kind for', async () => {
    const p = await project(
      'vm-images-boat',
      files(
        "boat({ dockerfile: './image/Dockerfile' })",
        "import { boat } from 'reeval/sandbox/boat'",
      ),
    )
    const env = { BOAT_BASE_URL: api.url, BOAT_API_KEY: api.key, XDG_CACHE_HOME: hostCache() }
    const cli = (args: string[]) => runCli(p.dir, args, { env, timeoutMs: 90_000 })

    const plan = await cli(['image', 'build', '--dry-run'])
    const name = /\+ .* (reeval-img-[0-9a-f]{12}) {2}\(to build\)/.exec(plan.stdout)?.[1]
    assert.ok(name, plan.stdout + plan.stderr)
    api.snapshots.set(name, {
      name,
      status: 'ready',
      sourceSandboxId: 'bx_other',
      sizeBytes: 300_000_000,
      polls: 0,
    })
    const saved = await cli(['image', 'build', '--dry-run'])
    assert.match(saved.stdout, new RegExp(`✓ boat.* ${name} {2}\\(saved\\)`))
    const built = await cli(['image', 'build'])
    assert.equal(built.code, 0, built.stdout + built.stderr)
    assert.match(built.stdout, new RegExp(`✓ boat.*: snapshot ${name} saved`))

    const list = await cli(['image', 'list'])
    assert.equal(list.code, 0, list.stdout + list.stderr)
    assert.match(
      list.stdout,
      new RegExp(`boat +${name} +ready +300 MB +saved .* used just now +boat`),
    )

    api.snapshots.set('reeval-img-000000000000', {
      name: 'reeval-img-000000000000',
      status: 'ready',
      sourceSandboxId: 'bx_other',
      sizeBytes: 100_000_000,
      createdAt: new Date(Date.now() - 30 * DAY).toISOString(),
      polls: 0,
    })
    const cleaned = await cli(['image', 'clean'])
    assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr)
    assert.match(cleaned.stdout, /✓ deleted boat reeval-img-000000000000 \(100 MB\)/)
    assert.match(cleaned.stdout, new RegExp(`kept boat ${name}: used in the last hour`))
    assert.deepEqual([...api.snapshots.keys()], [name])

    const noKey = await runCli(p.dir, ['image', 'list'], {
      env: { BOAT_BASE_URL: api.url, XDG_CACHE_HOME: hostCache() },
      timeoutMs: 90_000,
    })
    assert.equal(noKey.code, 2, noKey.stdout + noKey.stderr)
    assert.match(noKey.stdout + noKey.stderr, /BOAT_API_KEY/)

    const bad = await cli(['image', 'clean', '--provider', 'tart'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr + bad.stdout, /--provider is boat or daytona \(got "tart"\)/)
    const none = await cli(['image', 'clean', '--provider', 'daytona'])
    assert.equal(none.code, 0)
    assert.match(none.stdout, /No eval runs in a daytona\(\) sandbox/)
  })
})
