// What `tart()` clones, before any attempt: `reeval run` refuses an image Tart doesn't have, and
// `reeval image build` pulls it (with progress, room for it checked first, and no Docker), on a
// fake `tart` and a fake registry that answers as ghcr.io does, with a token.
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { formatSize, pullSpace, tartImageSize, tartPull } from '../src/sandbox/tart-images.ts'
import { parseTartRef, tartTagWarning } from '../src/sandbox/tart-ref.ts'
import { project, readRun, runCli } from './helpers.ts'
import { fakeDigest, fakeTart } from './support/fake-tart.ts'

const posix = process.platform !== 'win32'

/** Each repository's layers: what it downloads, and what Tart unpacks each to. */
const REPOS: Record<string, Array<{ size: number; uncompressed?: number }>> = {
  'cirruslabs/small': [
    { size: 11e9, uncompressed: 40e9 },
    { size: 1e9, uncompressed: 10e9 },
    { size: 4e3 },
  ],
  'cirruslabs/huge': [{ size: 30e9, uncompressed: 9e17 }],
}

let registry: Server
let host = ''
before(async () => {
  registry = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/token') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ token: `pull:${url.searchParams.get('scope')}` }))
    }
    const m = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url.pathname)
    const layers = m && REPOS[m[1] as string]
    if (!m || !layers) return res.writeHead(404).end()
    if (req.headers.authorization !== `Bearer pull:repository:${m[1]}:pull`) {
      res.setHeader(
        'www-authenticate',
        `Bearer realm="http://${host}/token",service="fake",scope="repository:${m[1]}:pull"`,
      )
      return res.writeHead(401).end()
    }
    res.setHeader('content-type', 'application/vnd.oci.image.manifest.v1+json')
    res.end(
      JSON.stringify({
        schemaVersion: 2,
        layers: layers.map((l) => ({
          size: l.size,
          ...(l.uncompressed
            ? { annotations: { 'org.cirruslabs.tart.uncompressed-size': String(l.uncompressed) } }
            : {}),
        })),
      }),
    )
  })
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${(registry.address() as AddressInfo).port}`
})
after(() => registry.close())

describe('Tart image names', () => {
  test('an OCI image by host, repository and tag or digest; anything without a / a local VM', () => {
    assert.deepEqual(parseTartRef('ghcr.io/cirruslabs/macos-sequoia-base:15.6'), {
      oci: true,
      host: 'ghcr.io',
      repo: 'cirruslabs/macos-sequoia-base',
      tag: '15.6',
      digest: null,
    })
    assert.deepEqual(parseTartRef('127.0.0.1:5000/a/b'), {
      oci: true,
      host: '127.0.0.1:5000',
      repo: 'a/b',
      tag: null,
      digest: null,
    })
    assert.deepEqual(parseTartRef('ghcr.io/a/b@sha256:abc'), {
      oci: true,
      host: 'ghcr.io',
      repo: 'a/b',
      tag: null,
      digest: 'sha256:abc',
    })
    assert.deepEqual(parseTartRef('ghcr.io/a/b:latest@sha256:abc'), {
      oci: true,
      host: 'ghcr.io',
      repo: 'a/b',
      tag: null,
      digest: 'sha256:abc',
    })
    assert.deepEqual(parseTartRef('sequoia'), { oci: false, name: 'sequoia' })
  })

  test('warns of :latest and of no tag, not of a version, a digest or a local VM', () => {
    assert.match(tartTagWarning('ghcr.io/a/b:latest') ?? '', /uses the moving tag "latest"/)
    assert.match(tartTagWarning('ghcr.io/a/b') ?? '', /uses no tag \(so "latest"\)/)
    assert.match(tartTagWarning('ghcr.io/a/b') ?? '', /Pin a digest \(ghcr\.io\/a\/b@sha256:…\)/)
    assert.equal(tartTagWarning('ghcr.io/a/b:15.6'), null)
    assert.equal(tartTagWarning('ghcr.io/a/b@sha256:abc'), null)
    assert.equal(tartTagWarning('sequoia'), null)
  })

  test("an image's size from its registry's manifest, with an anonymous token", async () => {
    assert.deepEqual(await tartImageSize(`${host}/cirruslabs/small:15.6`), {
      download: 12e9 + 4e3,
      disk: 50e9 + 4e3,
    })
    assert.equal(await tartImageSize(`${host}/cirruslabs/gone:1`), null)
    assert.equal(await tartImageSize('sequoia'), null)
    assert.deepEqual(
      [formatSize(12e9), formatSize(1.4e9), formatSize(3e8)],
      ['12 GB', '1.4 GB', '300 MB'],
    )
  })

  test("tart pull's progress: every line, and its percentages once every ten points", async (t) => {
    if (!posix) return t.skip('the fake tart is a bash script')
    const fake = fakeTart()
    const saved = { PATH: process.env.PATH, TART_HOME: process.env.TART_HOME }
    Object.assign(process.env, fake.env)
    const lines: string[] = []
    try {
      await tartPull('ghcr.io/a/b:1', { onLine: (l) => lines.push(l) })
    } finally {
      Object.assign(process.env, saved)
    }
    assert.deepEqual(lines, [
      'pulling manifest...',
      'pulling disk (1.2 GB compressed)...',
      '0%',
      '10%',
      '25%',
      '50%',
      '75%',
      '99%',
      '100%',
    ])
  })
})

const CONFIG = `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { tart } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness({}),
  sandbox: tart({ image: process.env.TART_IMAGE ?? '' }),
  egress: 'allow-all',
})
`
const EVAL = `import { evaluate, expect } from 'reeval'

evaluate('works in the VM', async (c) => {
  expect((await c.exec('printf ok')).stdout).toBe('ok')
})
`

/** A `docker` and `podman` that log being called and fail, so a test sees any use of them. */
function noDocker(bin: string): () => string[] {
  const log = join(bin, '..', 'docker-calls')
  for (const name of ['docker', 'podman']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
}

describe('tart() images before the run', {
  skip: !posix && 'the fake tart is a bash script',
}, () => {
  const setup = async (image: string, extra: NodeJS.ProcessEnv = {}) => {
    const fake = fakeTart()
    const dockerCalls = noDocker(join(fake.dir, 'bin'))
    const p = await project('tart-images', {
      'reeval.config.ts': CONFIG,
      'evals/vm.eval.ts': EVAL,
    })
    // A petabyte free, whatever the runner has: the huge image still doesn't fit.
    const env = {
      ...fake.env,
      TART_IMAGE: image,
      REEVAL_TEST_TART_ANY_HOST: '1',
      REEVAL_TEST_TART_FREE_BYTES: '1e15',
      ...extra,
    }
    const cli = (args: string[]) => runCli(p.dir, args, { env })
    const pulls = () => fake.log().filter((l) => l.startsWith('pull'))
    return { p, cli, pulls, dockerCalls, fake }
  }

  test("reeval run refuses an image Tart doesn't have, naming it, its size and the fix", async () => {
    const image = `${host}/cirruslabs/small:15.6`
    const { cli, pulls, dockerCalls } = await setup(image)
    const r = await cli(['run'])
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.ok(
      (r.stdout + r.stderr).includes(
        [
          "Tart doesn't have the image tart() clones, and reeval run doesn't pull images:",
          `  ${image} (about 12 GB to download)`,
          `Pull it with tart pull ${image}, or pull every image the plan needs with reeval image build, then run again.`,
        ].join('\n'),
      ),
      r.stdout + r.stderr,
    )
    assert.deepEqual(pulls(), [], 'nothing pulled')
    assert.deepEqual(dockerCalls(), [], 'no Docker')
  })

  test('reeval image build pulls it with progress and no Docker; then the run starts from it', async () => {
    const image = `${host}/cirruslabs/small:15.6`
    const { p, cli, pulls, dockerCalls, fake } = await setup(image)

    const plan = await cli(['image', 'build', '--dry-run'])
    assert.equal(plan.code, 0, plan.stdout + plan.stderr)
    assert.match(
      plan.stdout,
      new RegExp(
        `^  \\+ tart:small:15\\.6 · 1 eval  ${image.replace(/\./g, '\\.')}  \\(to pull: about 12 GB to download\\)$`,
        'm',
      ),
    )
    assert.deepEqual(pulls(), [], '--dry-run pulls nothing')

    const built = await cli(['image', 'build'])
    assert.equal(built.code, 0, built.stdout + built.stderr)
    assert.match(built.stdout, new RegExp(`^tart pull ${image.replace(/\./g, '\\.')}$`, 'm'))
    assert.match(built.stdout, /^tart:small:15\.6: 50%$/m, 'its progress, labeled')
    assert.doesNotMatch(built.stdout, /: 3%$/m, 'once every ten points')
    const digest = fakeDigest(image)
    assert.match(built.stdout, new RegExp(`^✓ tart:small:15\\.6: .+ ${digest.slice(7, 19)}$`, 'm'))
    assert.match(built.stdout, /^1 image ready$/m)
    assert.deepEqual(pulls(), [`pull ${image}`])
    const link = readlinkSync(
      join(fake.env.TART_HOME ?? '', 'cache', 'OCIs', host, 'cirruslabs', 'small', '15.6'),
    )
    assert.ok(isAbsolute(link), `Tart links a tag to its digest by absolute path, not ${link}`)

    const again = await cli(['image', 'build', '--dry-run'])
    assert.match(again.stdout, new RegExp(`\\(ready: ${digest.slice(7, 19)}\\)$`, 'm'))

    const run = await cli(['run'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    assert.deepEqual(readRun(p.dir).evals[0]?.trial.vmImage, { ref: image, digest })
    assert.deepEqual(pulls(), [`pull ${image}`], 'the run pulled nothing')
    assert.deepEqual(dockerCalls(), [], 'no Docker, from any of them')
  })

  test("reeval image build refuses before pulling when the disk hasn't room, exit 3", async () => {
    const image = `${host}/cirruslabs/huge:1`
    const { cli, pulls, dockerCalls, fake } = await setup(image)
    const plan = await cli(['image', 'build', '--dry-run'])
    assert.equal(plan.code, 0, plan.stdout + plan.stderr)
    assert.match(
      plan.stdout,
      /^ {2}disk {2}needs about 900000000 GB in .+; \d+(\.\d)? [GM]B free: reeval image build refuses to pull$/m,
      'the dry run says so too',
    )
    const r = await cli(['image', 'build'])
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(
      r.stdout + r.stderr,
      new RegExp(
        `Not enough disk space to pull the image tart\\(\\) clones: Tart needs about 900000000 GB free in ${fake.env.TART_HOME}; there is \\d+(\\.\\d)? [GM]B\\.\\n  ${image.replace(/\./g, '\\.')} \\(about 30 GB to download, 900000000 GB on disk\\)\\nFree some space`,
      ),
    )
    assert.match(r.stdout + r.stderr, /tart pull .+ skips this check/)
    assert.doesNotMatch(r.stderr, /reeval report/, 'a full disk is no bug to report')
    assert.deepEqual(pulls(), [])
    assert.deepEqual(dockerCalls(), [])
  })

  test("in a mixed plan, Tart's disk refusal still prints when Docker's check refuses, exit 2", async () => {
    const image = `${host}/cirruslabs/huge:1`
    const fake = fakeTart()
    noDocker(join(fake.dir, 'bin'))
    const p = await project('tart-images-mixed-short', {
      'reeval.config.ts': CONFIG,
      'evals/vm.eval.ts': EVAL,
      'evals/d.eval.ts': `import { evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

evaluate('in docker', { sandbox: docker() }, async () => {
  expect(1).toBe(1)
})
`,
    })
    const env = { ...fake.env, TART_IMAGE: image, REEVAL_TEST_TART_ANY_HOST: '1' }
    const r = await runCli(p.dir, ['image', 'build'], { env, timeoutMs: 120_000 })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stdout, /^✗ tart \(1 eval\): Not enough disk space to pull/m, r.stdout)
    assert.match(r.stdout, /^✗ docker \(1 eval\): /m, r.stdout)
  })

  test("the disk check leaves the plan's own images out of what Tart would prune", async (t) => {
    if (!posix) return t.skip('the fake tart is a bash script')
    const have = `${host}/cirruslabs/small:15.6`
    const fake = fakeTart([have])
    const saved = {
      TART_HOME: process.env.TART_HOME,
      REEVAL_TEST_TART_FREE_BYTES: process.env.REEVAL_TEST_TART_FREE_BYTES,
    }
    const cached = join(fake.env.TART_HOME ?? '', 'cache', 'OCIs', host, 'cirruslabs', 'small')
    writeFileSync(join(cached, fakeDigest(have), 'disk.img'), Buffer.alloc(4e6, 1))
    const other = join(fake.env.TART_HOME ?? '', 'cache', 'OCIs', 'ghcr.io', 'a', 'old', 'sha256:0')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'disk.img'), Buffer.alloc(1e6, 1))
    Object.assign(process.env, { TART_HOME: fake.env.TART_HOME, REEVAL_TEST_TART_FREE_BYTES: '1' })
    try {
      const missing = [{ image: 'ghcr.io/a/b:1', size: { download: 1, disk: 2e6 } }]
      const space = await pullSpace(missing, [have])
      assert.ok(space && space.prunable >= 1e6 && space.prunable < 4e6, `${space?.prunable}`)
      assert.equal(space?.verdict, 'short')
      process.env.REEVAL_TEST_TART_FREE_BYTES = 'lots'
      const real = (await pullSpace(missing, [have]))?.free
      assert.ok(Number.isFinite(real) && real !== 1, `not a number is ignored: ${real}`)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  test('a pull that fits once Tart prunes its cache warns and pulls', async () => {
    const image = `${host}/cirruslabs/small:15.6`
    const needs = 50e9 + 4e3 + 134_217_728
    const { cli, pulls, fake } = await setup(image, {
      REEVAL_TEST_TART_FREE_BYTES: String(needs - 1e6),
    })
    const old = join(fake.env.TART_HOME ?? '', 'cache', 'OCIs', 'ghcr.io', 'a', 'old', 'sha256:0')
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, 'disk.img'), Buffer.alloc(4e6, 1))

    const plan = await cli(['image', 'build', '--dry-run'])
    assert.match(
      plan.stdout,
      /^ {2}disk {2}needs about 50 GB in .+; 50 GB free, and Tart prunes its cache \(4 MB in Tart's cache\) to make room$/m,
      plan.stdout,
    )
    const r = await cli(['image', 'build'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^warning: pulling needs about 50 GB in .+ and 50 GB is free: tart pull will prune images it cached \(4 MB\) to make room\.$/m,
    )
    assert.deepEqual(pulls(), [`pull ${image}`])
  })

  test("an image its registry won't size is pulled, flagged, and left out of the disk check", async () => {
    const image = `${host}/cirruslabs/gone:1`
    const { cli, pulls } = await setup(image)
    const plan = await cli(['image', 'build', '--dry-run'])
    assert.match(plan.stdout, /\(to pull: size unknown\)$/m, plan.stdout)
    assert.match(
      plan.stdout,
      /^ {2}disk {2}.+ free in .+; the registry didn't size the image to pull, so the disk check can't count it$/m,
      plan.stdout,
    )
    const r = await cli(['image', 'build'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(
      r.stdout.includes(
        `${image}: its registry didn't give its size, so the disk check doesn't count it`,
      ),
      r.stdout,
    )
    assert.deepEqual(pulls(), [`pull ${image}`])
  })

  test('a pull that fails fails its image, exit 3, naming what tart said', async () => {
    const image = `${host}/cirruslabs/small:15.6`
    const { cli } = await setup(image, {
      FAKE_TART_PULL_FAILS: 'unauthorized: authentication required',
    })
    const r = await cli(['image', 'build'])
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /^✗ tart:small:15\.6 \(1 eval\): tart pull .+ failed: unauthorized: authentication required$/m,
    )
    assert.match(r.stdout, /^1 of 1 image failed to pull$/m)
  })

  test('reeval image build warns of an image with no tag', async () => {
    const image = `${host}/cirruslabs/small`
    const { cli } = await setup(image)
    const r = await cli(['image', 'build', '--dry-run'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(r.stdout.includes(`warning: tart(${image}) uses no tag (so "latest")`), r.stdout)
  })

  test("a host without Tart still builds the plan's Docker images", async () => {
    const fake = fakeTart()
    const dockerCalls = noDocker(join(fake.dir, 'bin'))
    const p = await project('tart-images-mixed', {
      'reeval.config.ts': CONFIG,
      'evals/vm.eval.ts': EVAL,
      'evals/d.eval.ts': `import { evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

evaluate('in docker', { sandbox: docker() }, async () => {
  expect(1).toBe(1)
})
`,
    })
    const env = { PATH: fake.env.PATH, TART_IMAGE: `${host}/cirruslabs/small:15.6` }
    const r = await runCli(p.dir, ['image', 'build'], { env, timeoutMs: 120_000 })
    // Past Tart's refusal of this host, to Docker: here, the shim that says it isn't running.
    assert.ok(dockerCalls().length > 0, r.stdout + r.stderr)
    assert.doesNotMatch(r.stderr, /needs a Mac with Apple Silicon/, 'not stopped by Tart')
  })

  test('an image with no tag, which Tart lists as :latest, is pulled once and then runs', async () => {
    const image = `${host}/cirruslabs/small`
    const { p, cli, pulls } = await setup(image)
    const built = await cli(['image', 'build'])
    assert.equal(built.code, 0, built.stdout + built.stderr)
    const again = await cli(['image', 'build', '--dry-run'])
    assert.match(again.stdout, /\(ready: [0-9a-f]{12}\)$/m, again.stdout)
    const run = await cli(['run'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    assert.deepEqual(readRun(p.dir).evals[0]?.trial.vmImage, {
      ref: image,
      digest: fakeDigest(image),
    })
    assert.deepEqual(pulls(), [`pull ${image}`])
  })
})
