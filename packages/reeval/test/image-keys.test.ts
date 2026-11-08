// Sandbox image tags across machines: `prepareImage` against a fake `docker` CLI whose builds give
// each machine its own image ids, as real builds do (they aren't reproducible), and whose registry
// is a directory both machines share. The same inputs must give the same tags everywhere, and a
// tag one machine pushed must be what another pulls instead of building.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  contextHash,
  dockerfileTag,
  harnessImageFor,
  harnessLabel,
  imageFor,
  installLayerTag,
  LABEL,
  PLATFORM,
  pluginLayerTag,
  reevalImageKey,
  registryProblem,
  registryRef,
} from '@reeval/sandbox-docker'
import { createBuilds, prepareImage } from '../src/sandbox/prepare.ts'
import { imageRecipeKey } from '../src/sandbox/recipe.ts'
import type { DockerSandboxDescriptor } from '../src/types.ts'
import { fakeConfig, project, runCli, tempDir } from './helpers.ts'

const FAKE_DOCKER = `#!/usr/bin/env node
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const machine = process.env.FAKE_MACHINE
const local = path.join(process.env.FAKE_STATE, machine)
const registry = path.join(process.env.FAKE_STATE, 'registry')
fs.mkdirSync(local, { recursive: true })
fs.mkdirSync(registry, { recursive: true })
const file = (dir, ref) => path.join(dir, encodeURIComponent(ref) + '.json')
const read = (dir, ref) => (fs.existsSync(file(dir, ref)) ? JSON.parse(fs.readFileSync(file(dir, ref), 'utf8')) : null)
const write = (dir, ref, image) => fs.writeFileSync(file(dir, ref), JSON.stringify(image))
const fresh = (labels) => ({ labels, platform: process.env.FAKE_PLATFORM, id: 'sha256:' + createHash('sha256').update(machine + randomUUID()).digest('hex') })
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1) }
const flag = (name) => args.filter((a, i) => args[i - 1] === name)
if (args[0] === 'image' && args[1] === 'inspect') {
  const ref = args.at(-1)
  const image = read(local, ref)
  if (!image) fail('Error: No such image: ' + ref)
  process.stdout.write(args[3].includes('config')
    ? JSON.stringify({ config: { Labels: image.labels }, id: image.id, repoDigests: null, os: image.platform.split('/')[0], arch: image.platform.split('/')[1] })
    : '2026-11-06T00:00:00Z\\n')
} else if (args[0] === 'image' && args[1] === 'rm') {
  fs.rmSync(file(local, args[2]), { force: true })
} else if (args[0] === 'build') {
  if (args.at(-1) === '-') fs.readFileSync(0)
  const labels = Object.fromEntries(flag('--label').map((l) => l.split('=')))
  const base = flag('--build-arg').find((a) => a.startsWith('REEVAL_BASE='))?.slice('REEVAL_BASE='.length)
  const dockerfile = flag('--file')[0]
  const inherited = base && dockerfile && fs.readFileSync(dockerfile, 'utf8').includes('REEVAL_BASE') ? read(local, base)?.labels : {}
  const tag = flag('--tag')[0]
  write(local, tag, fresh({ ...inherited, ...labels }))
  fs.appendFileSync(path.join(process.env.FAKE_STATE, machine + '-builds.log'), tag + '\\n')
} else if (args[0] === 'tag') {
  const image = read(local, args[1])
  if (!image) fail('Error: No such image: ' + args[1])
  write(local, args[2], image)
} else if (args[0] === 'push') {
  const image = read(local, args[1])
  if (!image) fail('Error: No such image: ' + args[1])
  write(registry, args[1], image)
} else if (args[0] === 'pull') {
  const image = read(registry, args.at(-1))
  if (!image) fail('Error response from daemon: manifest unknown')
  write(local, args.at(-1), image)
} else if (args[0] === 'version') {
  process.stdout.write((process.env.FAKE_SERVER_PLATFORM ?? '') + '\\n')
} else if (args[0] === 'buildx') {
  const digests = path.join(process.env.FAKE_STATE, machine + '-upstream.json')
  const digest = fs.existsSync(digests) ? JSON.parse(fs.readFileSync(digests, 'utf8'))[args.at(-1)] : null
  if (!digest) fail('ERROR: no registry in this test')
  process.stdout.write(JSON.stringify(digest) + '\\n')
}
`

const harness = 'cursor'
const reevalImage = imageFor(harness)

function world() {
  const dir = tempDir('reeval-image-keys-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 })
  const state = join(dir, 'state')
  const project = join(dir, 'project')
  mkdirSync(project)
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_PLATFORM: PLATFORM }
  /** One machine: its own images, whose ids are its own, and the shared registry. */
  const machine = (name: string, own: Record<string, string> = {}) => {
    const local = join(state, name)
    mkdirSync(local, { recursive: true })
    const seed = (ref: string, labels: Record<string, string>, dir = local) =>
      writeFileSync(
        join(dir, `${encodeURIComponent(ref)}.json`),
        JSON.stringify({ labels, platform: PLATFORM, id: `sha256:${name}-${ref}`.padEnd(71, '0') }),
      )
    return {
      seed,
      /** What the upstream registry says each tag names now, as this machine looks it up. */
      upstream: (digests: Record<string, string>) =>
        writeFileSync(join(state, `${name}-upstream.json`), JSON.stringify(digests)),
      /** Seeds reeval's own image for the harness, as `reeval image build` left it here. */
      seedReeval: () =>
        seed(reevalImage, {
          [LABEL.context]: contextHash(),
          [LABEL.agentVersion]: '1.0.0',
          [LABEL.harness]: harnessLabel(harness),
          [LABEL.key]: reevalImageKey(harness),
        }),
      builds: () => {
        const log = join(state, `${name}-builds.log`)
        return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
      },
      has: (ref: string) => existsSync(join(local, `${encodeURIComponent(ref)}.json`)),
      prepare: async (
        sandbox: Omit<DockerSandboxDescriptor, 'kind'>,
        options: {
          registry?: string
          push?: boolean
          refresh?: 'force'
          log?: (line: string) => void
        } = {},
      ) => {
        const saved = { ...process.env }
        Object.assign(process.env, env, { FAKE_MACHINE: name }, own)
        try {
          return await prepareImage(
            { kind: 'docker', ...sandbox },
            harness,
            project,
            AbortSignal.timeout(30_000),
            createBuilds(options),
          )
        } finally {
          process.env = saved
        }
      },
    }
  }
  /** Puts an image straight into the shared registry, as someone else's push would. */
  const publish = (remote: string, labels: Record<string, string>, platform = PLATFORM) => {
    const dir = join(state, 'registry')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${encodeURIComponent(remote)}.json`),
      JSON.stringify({ labels, platform, id: `sha256:${'f'.repeat(64)}` }),
    )
  }
  const inRegistry = () =>
    readdirSync(join(state, 'registry')).map((f) => decodeURIComponent(f.replace(/\.json$/, '')))
  return { project, machine, publish, inRegistry }
}

describe('sandbox image tags are content keys', () => {
  test('an install layer on reeval image: the same tag on two machines whose image ids differ', async () => {
    const { machine } = world()
    const a = machine('a')
    const b = machine('b')
    a.seedReeval()
    b.seedReeval()
    const install = ['apt-get install -y jq']
    const onA = await a.prepare({ install })
    const onB = await b.prepare({ install })
    assert.match(onA.ref, /^reeval-install:[0-9a-f]{16}$/)
    assert.equal(onB.ref, onA.ref)
    assert.notEqual(onB.id, onA.id, 'each machine built its own image')
    // Canary: other commands are another layer.
    assert.notEqual((await b.prepare({ install: ['true'] })).ref, onA.ref)
  })

  test('a Dockerfile FROM ${REEVAL_BASE} and an install layer on it: the same tags on both machines', async () => {
    const { project, machine } = world()
    const dockerfile = join(project, 'tools', 'Dockerfile')
    mkdirSync(join(project, 'tools'))
    writeFileSync(dockerfile, 'ARG REEVAL_BASE\nFROM ${REEVAL_BASE}\nRUN true\n')
    const a = machine('a')
    const b = machine('b')
    a.seedReeval()
    b.seedReeval()
    const onA = await a.prepare({ dockerfile, install: ['echo hi'] })
    const onB = await b.prepare({ dockerfile, install: ['echo hi'] })
    assert.equal(onB.ref, onA.ref)
    assert.equal(onB.base, onA.base)
    assert.match(onA.base, /^reeval-dockerfile:tools-[0-9a-f]{16}$/)
    assert.notEqual(onB.id, onA.id)
  })

  test("a from image's layers hash the digest it was built on, not its id", async () => {
    const { machine } = world()
    const from = 'python:3.12-slim'
    const baked = harnessImageFor(harness, from)
    const labels = (digest: string) => ({
      [LABEL.fromDigest]: digest,
      [LABEL.agentVersion]: '1.0.0',
    })
    const a = machine('a')
    const b = machine('b')
    const c = machine('c')
    a.seed(baked, labels(`sha256:${'1'.repeat(64)}`))
    b.seed(baked, labels(`sha256:${'1'.repeat(64)}`))
    c.seed(baked, labels(`sha256:${'2'.repeat(64)}`))
    const onA = await a.prepare({ from, install: ['echo hi'] })
    assert.equal((await b.prepare({ from, install: ['echo hi'] })).ref, onA.ref)
    // Canary: a build on what the tag named later is another base.
    assert.notEqual((await c.prepare({ from, install: ['echo hi'] })).ref, onA.ref)
  })

  test('one machine pushes its images; another pulls them instead of building; a registry without them is a build', async () => {
    const { machine } = world()
    const registry = 'registry.test:5000/team/reeval'
    const install = ['echo hi']
    const a = machine('a')
    a.seedReeval()
    const pushed = await a.prepare({ install }, { registry, push: true })
    assert.deepEqual(a.builds(), [pushed.ref], 'machine a built the install layer')

    const b = machine('b')
    const pulled = await b.prepare({ install }, { registry })
    assert.deepEqual(b.builds(), [], 'machine b built nothing')
    assert.equal(pulled.ref, pushed.ref)
    assert.equal(pulled.id, pushed.id, "machine b has machine a's image")
    assert.ok(b.has(reevalImage), "reeval's image came from the registry too")

    // Canary: commands nobody pushed are built.
    const c = machine('c')
    const other = await c.prepare({ install: ['echo other'] }, { registry })
    assert.deepEqual(c.builds(), [other.ref])
    // Canary: without --push, nothing reaches the registry.
    const d = machine('d')
    d.seedReeval()
    const local = await d.prepare({ install: ['echo local'] }, { registry })
    const e = machine('e')
    e.seedReeval()
    await e.prepare({ install: ['echo local'] }, { registry })
    assert.deepEqual(e.builds(), [local.ref])
  })

  test("the registry tag pins content the local tag doesn't", () => {
    const registry = 'localhost:5000/reeval/'
    const install = {
      ref: 'reeval-install:0123456789abcdef',
      key: 'reeval-install:0123456789abcdef',
    }
    assert.equal(
      registryRef(registry, install, 'linux/amd64'),
      'localhost:5000/reeval/reeval-install:0123456789abcdef-linux-amd64',
    )
    const one = registryRef(registry, { ref: reevalImage, key: `${reevalImage}+aaaa` })
    const two = registryRef(registry, { ref: reevalImage, key: `${reevalImage}+bbbb` })
    assert.match(
      one,
      new RegExp(
        `^localhost:5000/reeval/${reevalImage}-[0-9a-f]{12}-${PLATFORM.replace('/', '-')}$`,
      ),
    )
    assert.notEqual(one, two, 'a new reeval base is a new registry tag')
    assert.equal(registryProblem('ghcr.io/acme/reeval'), null)
    assert.equal(registryProblem('localhost:5000'), null)
    assert.match(registryProblem('https://ghcr.io/acme') ?? '', /without a scheme/)
    assert.match(registryProblem('ghcr.io/acme/reeval:latest') ?? '', /without a scheme, tag/)
  })
  test('every registry ref names the platform, so another architecture never pulls it', () => {
    const registry = 'localhost:5000/reeval'
    const platformTag = PLATFORM.replace('/', '-')
    for (const layer of [
      { ref: reevalImage, key: reevalImageKey(harness) },
      { ref: 'reeval-install:0123456789abcdef', key: 'reeval-install:0123456789abcdef' },
    ]) {
      const here = registryRef(registry, layer)
      assert.ok(here.endsWith(`-${platformTag}`), here)
      // Canary: the same layer for another architecture is another ref.
      assert.notEqual(registryRef(registry, layer, 'linux/riscv64'), here)
    }
  })

  test("a pulled image whose key label or platform doesn't match is built instead", async () => {
    const { machine, publish } = world()
    const registry = 'registry.test:5000/reeval'
    const install = ['echo checked']
    const a = machine('a')
    a.seedReeval()
    const ref = (await a.prepare({ install })).ref
    const remote = registryRef(registry, { ref, key: ref })

    const cases = [
      [
        { [LABEL.key]: 'reeval-install:0000000000000000' },
        PLATFORM,
        /label is reeval-install:0+, not/,
      ],
      [{}, PLATFORM, /has no ai\.reeval\.key label/],
      [{ [LABEL.key]: ref }, 'linux/riscv64', /it's for linux\/riscv64, not/],
    ] as const
    for (const [i, [labels, platform, reason]] of cases.entries()) {
      publish(remote, labels, platform)
      const b = machine(`b${i}`)
      b.seedReeval()
      const lines: string[] = []
      const got = await b.prepare({ install }, { registry, log: (line) => lines.push(line) })
      assert.equal(got.ref, ref)
      assert.deepEqual(b.builds(), [ref], 'built, not pulled')
      assert.match(lines.join('\n'), reason)
    }
    // Canary: the image as reeval labels it is pulled.
    publish(remote, { [LABEL.key]: ref })
    const c = machine('c')
    c.seedReeval()
    await c.prepare({ install }, { registry })
    assert.deepEqual(c.builds(), [])
  })

  test('--force builds the install layer again, though its tag is the same', async () => {
    const { machine } = world()
    const a = machine('a')
    a.seed('acme/tools:1', {
      [LABEL.agentVersion]: '1.0.0',
      [LABEL.harness]: harnessLabel(harness),
    })
    const sandbox = { image: 'acme/tools:1', install: ['echo forced'] }
    const first = await a.prepare(sandbox)
    // Canary: without --force it's reused.
    await a.prepare(sandbox)
    assert.deepEqual(a.builds(), [first.ref])
    const forced = await a.prepare(sandbox, { refresh: 'force' })
    assert.equal(forced.ref, first.ref)
    assert.notEqual(forced.id, first.id, 'a new image under the same tag')
    assert.ok(a.builds().filter((ref) => ref === first.ref).length === 2, a.builds().join('\n'))
  })

  test("a Dockerfile's key holds the digest its moving base names: a base that moved is another image", async () => {
    const { project, machine } = world()
    const dockerfile = join(project, 'node', 'Dockerfile')
    mkdirSync(join(project, 'node'))
    writeFileSync(
      dockerfile,
      'FROM node:22 AS node\nARG REEVAL_BASE\nFROM ${REEVAL_BASE}\nCOPY --from=node /usr/local/bin/node /opt/node\n',
    )
    const registry = 'registry.test:5000/reeval'
    const install = ['echo on node']
    const one = { 'node:22': `sha256:${'1'.repeat(64)}` }
    const a = machine('a')
    a.seedReeval()
    a.upstream(one)
    const onA = await a.prepare({ dockerfile, install }, { registry, push: true })
    const b = machine('b')
    b.seedReeval()
    b.upstream(one)
    const onB = await b.prepare({ dockerfile, install }, { registry })
    assert.equal(onB.ref, onA.ref)
    assert.deepEqual(b.builds(), [], 'the same base digest is the same image, pulled')
    // Canary: node:22 moved, so the Dockerfile and the layer on it are built, under a new key.
    const c = machine('c')
    c.seedReeval()
    c.upstream({ 'node:22': `sha256:${'2'.repeat(64)}` })
    const onC = await c.prepare({ dockerfile, install }, { registry })
    assert.equal(onC.base, onA.base, 'the same files are the same local tag')
    assert.notEqual(onC.ref, onA.ref, 'the install layer hashes the new key')
    assert.ok(c.builds().includes(onC.base), c.builds().join('\n'))
  })
  test("a Dockerfile whose bases can't all be named is this machine's alone, and so is every layer on it", async () => {
    const node = `sha256:${'1'.repeat(64)}`
    const cases = {
      'FROM a build arg':
        'ARG REEVAL_BASE\nARG BASE=node:22\nFROM ${BASE} AS tools\nFROM ${REEVAL_BASE}\nCOPY --from=tools /a /b\n',
      'a continued COPY --from a build arg':
        'ARG REEVAL_BASE\nFROM ${REEVAL_BASE}\nCOPY \\\n  --from=$TOOLS /a /b\n',
      'a RUN --mount from a build arg':
        'ARG REEVAL_BASE\nFROM ${REEVAL_BASE}\nRUN --mount=type=bind,from=${TOOLS},target=/t true\n',
      "a base that doesn't resolve":
        'ARG REEVAL_BASE\nFROM ${REEVAL_BASE}\nCOPY --from=node:23 /a /b\n',
    }
    for (const [what, text] of Object.entries(cases)) {
      const { project, machine, inRegistry } = world()
      const dockerfile = join(project, 'tools', 'Dockerfile')
      mkdirSync(join(project, 'tools'))
      writeFileSync(dockerfile, text)
      const registry = 'registry.test:5000/reeval'
      const install = ['echo here']
      const a = machine('a')
      a.seedReeval()
      a.upstream({ 'node:22': node })
      const onA = await a.prepare({ dockerfile, install }, { registry, push: true })
      const b = machine('b')
      b.seedReeval()
      b.upstream({ 'node:22': node })
      const onB = await b.prepare({ dockerfile, install }, { registry })
      assert.ok(b.builds().includes(onB.base), `${what}: b built the Dockerfile`)
      assert.notEqual(
        onB.ref,
        onA.ref,
        `${what}: the install layer hashes each machine's own image`,
      )
      assert.deepEqual(
        inRegistry().filter((ref) => !ref.includes(reevalImage)),
        [],
        `${what}: nothing on it was pushed`,
      )
    }
    // Canary: a resolved base and REEVAL_BASE alone, continued or not, are shared.
    const { project, machine, inRegistry } = world()
    const dockerfile = join(project, 'tools', 'Dockerfile')
    mkdirSync(join(project, 'tools'))
    writeFileSync(
      dockerfile,
      'ARG REEVAL_BASE\nFROM \\\n  ${REEVAL_BASE}\nRUN --mount=type=bind,from=node:22,target=/n true\n',
    )
    const a = machine('a')
    a.seedReeval()
    a.upstream({ 'node:22': node })
    const onA = await a.prepare(
      { dockerfile, install: ['echo here'] },
      { registry: 'r.test/x', push: true },
    )
    assert.ok(
      inRegistry().some((ref) => ref.includes(onA.ref)),
      inRegistry().join('\n'),
    )
    const b = machine('b')
    b.seedReeval()
    b.upstream({ 'node:22': node })
    assert.equal(
      (await b.prepare({ dockerfile, install: ['echo here'] }, { registry: 'r.test/x' })).ref,
      onA.ref,
    )
    assert.deepEqual(b.builds(), [])
  })

  test("a push is under the platform the engine builds for, not this process's", async () => {
    const { machine, inRegistry } = world()
    const registry = 'registry.test:5000/reeval'
    const install = ['echo engine']
    const remote = { FAKE_SERVER_PLATFORM: 'linux/riscv64', FAKE_PLATFORM: 'linux/riscv64' }
    const a = machine('a', remote)
    a.seedReeval()
    const ref = (await a.prepare({ install }, { registry, push: true })).ref
    assert.ok(inRegistry().includes(`${registry}/${ref}-linux-riscv64`), inRegistry().join('\n'))
    // Another engine of that platform pulls it; this process's platform builds its own.
    const b = machine('b', remote)
    b.seedReeval()
    await b.prepare({ install }, { registry })
    assert.deepEqual(b.builds(), [])
    const c = machine('c')
    c.seedReeval()
    await c.prepare({ install }, { registry })
    assert.deepEqual(c.builds(), [ref])
  })
})

describe('imageRecipeKey: the key prepareImage builds, named from the recipe alone', () => {
  const node = `sha256:${'1'.repeat(64)}`
  const python = `sha256:${'3'.repeat(64)}`
  const digests: Record<string, string> = { 'node:22': node, 'python:3.12-slim': python }
  const resolve = (map: Record<string, string>) => async (ref: string) =>
    map[ref] ? { digest: map[ref] } : { error: `${ref} isn't in the test registry` }

  test('each kind of recipe, with an install layer on it: the same layers, in order, and the same key', async () => {
    const { project, machine } = world()
    const dir = join(project, 'images')
    mkdirSync(dir)
    const write = (name: string, text: string) => {
      mkdirSync(join(dir, name))
      writeFileSync(join(dir, name, 'Dockerfile'), text)
      return join(dir, name, 'Dockerfile')
    }
    const onReevalBase = write(
      'on-base',
      'FROM node:22 AS node\nARG REEVAL_BASE\nFROM ${REEVAL_BASE}\nCOPY --from=node /usr/local/bin/node /opt/\n',
    )
    const onNode = write('on-node', 'FROM node:22\nRUN true\n')
    const a = machine('a')
    a.seedReeval()
    a.upstream(digests)
    a.seed(harnessImageFor(harness, 'python:3.12-slim'), {
      [LABEL.fromDigest]: python,
      [LABEL.agentVersion]: '1.0.0',
    })
    const install = ['echo recipe']
    const recipes: Record<string, Omit<DockerSandboxDescriptor, 'kind'>> = {
      "reeval's image": { install },
      from: { from: 'python:3.12-slim', install },
      'a Dockerfile FROM ${REEVAL_BASE}': { dockerfile: onReevalBase, install },
      'a Dockerfile on another base, with the harness baked on': { dockerfile: onNode, install },
    }
    for (const [what, sandbox] of Object.entries(recipes)) {
      if (sandbox.dockerfile === onNode) {
        const { tag } = dockerfileTag(onNode, harness)
        a.seed(harnessImageFor(harness, tag), { [LABEL.agentVersion]: '1.0.0' })
      }
      const prepared = await a.prepare(sandbox)
      const recipe = await imageRecipeKey(sandbox, harness, { resolve: resolve(digests) })
      assert.ok('key' in recipe, what)
      // An install layer's tag hashes its parent's key, so the same tag is the same key chain.
      assert.equal(recipe.layers.at(-1)?.ref, prepared.ref, what)
      assert.equal(recipe.key, prepared.ref, what)
      assert.equal(recipe.layers.at(-2)?.ref, prepared.base, what)
      // Canary: a base that moved upstream is another key.
      const moved = await imageRecipeKey(sandbox, harness, {
        resolve: resolve({ 'node:22': `sha256:${'2'.repeat(64)}`, 'python:3.12-slim': node }),
      })
      assert.ok('key' in moved, what)
      if (sandbox.from || sandbox.dockerfile) assert.notEqual(moved.key, recipe.key, what)
      else assert.equal(moved.key, recipe.key, `${what}: nothing in it moves`)
    }
    const onNodeRecipe = await imageRecipeKey({ dockerfile: onNode }, harness, {
      resolve: resolve(digests),
    })
    assert.ok('key' in onNodeRecipe)
    assert.deepEqual(
      onNodeRecipe.layers.map((l) => l.ref),
      [
        dockerfileTag(onNode, harness).tag,
        harnessImageFor(harness, dockerfileTag(onNode, harness).tag),
      ],
    )
    const onBaseRecipe = await imageRecipeKey({ dockerfile: onReevalBase }, harness, {
      resolve: resolve(digests),
    })
    assert.ok('key' in onBaseRecipe)
    assert.deepEqual(
      onBaseRecipe.layers.map((l) => l.ref),
      [reevalImage, dockerfileTag(onReevalBase, harness).tag],
      'built on the harness image: nothing baked on',
    )
  })

  test('plugin builds stack on the install layer, each keyed on the one below', async () => {
    const spec = (tree: string) => ({
      context: '/nowhere',
      commit: null,
      tree,
      path: '.',
      cwd: '.',
      steps: [{ run: 'make' }],
    })
    const recipe = await imageRecipeKey({ install: ['true'] }, harness, {
      plugins: [spec('a'), spec('b')],
    })
    assert.ok('key' in recipe)
    const [base, install, one, two] = recipe.layers
    assert.equal(base?.key, reevalImageKey(harness))
    assert.equal(install?.ref, installLayerTag({ key: reevalImageKey(harness) }, [{ run: 'true' }]))
    assert.equal(one?.ref, pluginLayerTag({ key: install?.key ?? '' }, spec('a')))
    assert.equal(two?.ref, pluginLayerTag({ key: one?.key ?? '' }, spec('b')))
    assert.equal(recipe.key, two?.key)
  })

  test("a base the registry doesn't answer for, or a FROM behind a build arg, leaves it unresolved", async () => {
    const dir = tempDir('reeval-recipe-')
    const file = join(dir, 'Dockerfile')
    writeFileSync(file, 'ARG REEVAL_BASE\nFROM ${REEVAL_BASE}\nCOPY --from=node:23 /a /b\n')
    assert.deepEqual(
      await imageRecipeKey({ dockerfile: file }, harness, { resolve: resolve({}) }),
      {
        unresolved: { ref: 'node:23', reason: "node:23 isn't in the test registry" },
      },
    )
    writeFileSync(file, 'ARG BASE=node:22\nFROM ${BASE}\n')
    assert.deepEqual(
      await imageRecipeKey({ dockerfile: file }, harness, { resolve: resolve(digests) }),
      {
        unresolved: { ref: file, reason: 'a FROM, COPY --from or --mount names a build argument' },
      },
    )
    assert.deepEqual(await imageRecipeKey({ from: 'ghost:1' }, harness, { resolve: resolve({}) }), {
      unresolved: { ref: 'ghost:1', reason: "ghost:1 isn't in the test registry" },
    })
    assert.deepEqual(
      await imageRecipeKey({ image: 'node:22', install: ['true'] }, harness, {
        resolve: resolve(digests),
      }),
      { unresolved: { ref: 'node:22', reason: 'used as is: keyed on its local image id' } },
      'Docker keys an image used as is on its local id, which no registry names',
    )
  })
})

describe('--registry and --push', () => {
  test('--push needs --registry, and --registry is a registry prefix', async () => {
    const p = await project('image-registry-flags', {
      'reeval.config.ts': fakeConfig(),
      'evals/a.eval.ts': "import { evaluate } from 'reeval'\nevaluate('a', async () => {})\n",
    })
    const push = await runCli(p.dir, ['image', 'build', '--push'])
    assert.equal(push.code, 2, push.stdout + push.stderr)
    assert.match(push.stderr, /--push needs --registry/)
    for (const args of [
      ['image', 'build', '--registry', 'https://ghcr.io/acme'],
      ['run', '--dry-run', '--registry', 'ghcr.io/acme/reeval:latest'],
    ]) {
      const r = await runCli(p.dir, args)
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(r.stderr, /--registry is a registry and an optional path/)
    }
    // Canary: a registry prefix plans as usual.
    const ok = await runCli(p.dir, ['run', '--dry-run', '--registry', 'localhost:5000/reeval'])
    assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  })
})
