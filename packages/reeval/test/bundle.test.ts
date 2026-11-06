import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { BundleManifest } from '../src/bundle/types.ts'
import type { RunRecord } from '../src/history/types.ts'
import { readTar, type TarEntry, writeTar } from '../src/tarball.ts'
import { baseEnv, pkgRoot, project, readRun, runCli, spawnTool, tempDir } from './helpers.ts'

const fixture = join(pkgRoot, 'test/fixtures/bundle')
const TOKEN = 'bundle-check-token-value'

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** The fixture project, with a `.env` the bundle must leave out. */
async function fixtureProject() {
  const p = await project('bundle', {})
  cpSync(fixture, p.dir, { recursive: true })
  writeFileSync(join(p.dir, '.env'), `CHECK_TOKEN=${TOKEN}\n`)
  return p
}

/**
 * A temporary directory for `run --bundle` to extract into, below a `node_modules/reeval` that
 * stands in for the install: the fixture has no lockfile to install from.
 */
function extractRoot(): string {
  const dir = tempDir('bundle-tmp')
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(pkgRoot, join(dir, 'node_modules/reeval'), 'dir')
  return dir
}

const entriesOf = (file: string) => readTar(gunzipSync(readFileSync(file)))
const manifestOf = (entries: TarEntry[]): BundleManifest => {
  const m = entries.find((e) => e.path === 'manifest.json')
  assert.ok(m?.type === 'file')
  return JSON.parse(m.data.toString('utf8'))
}

/** `entries` with the manifest replaced by `edit`'s, as a new bundle file. */
function rewrite(
  entries: TarEntry[],
  out: string,
  edit: (m: BundleManifest) => BundleManifest = (m) => m,
): string {
  const manifest = edit(manifestOf(entries))
  const data = Buffer.from(JSON.stringify(manifest))
  const rest = entries.filter((e) => e.path !== 'manifest.json')
  writeFileSync(
    out,
    gzipSync(writeTar([{ type: 'file', path: 'manifest.json', mode: 0o644, mtime: 0, data }, ...rest])),
  )
  return out
}

/** What a run's record says about each eval that the files decide, not the machine or the clock. */
const outcomes = (run: RunRecord) =>
  run.evals.map((e) => ({
    id: e.id,
    fingerprint: e.fingerprint,
    sources: e.sources,
    outcome: e.outcome,
    attempts: e.attempts.map((a) => ({
      key: a.key,
      outcome: a.outcome,
      turns: a.turns.map((t) => [t.prompt, t.status, t.text]),
      assertions: (a.assertions ?? []).map((x) => [x.label, x.status]),
    })),
  }))

describe('reeval bundle', () => {
  let dir: string
  let file: string
  let entries: TarEntry[]

  before(async () => {
    dir = (await fixtureProject()).dir
    file = join(tempDir('bundle-out'), 'project.tar.gz')
    const made = await runCli(dir, ['bundle', '--out', file])
    assert.equal(made.code, 0, made.stderr)
    assert.match(made.stdout, /Bundled 5 files .* for 1 attempt/)
    assert.match(made.stdout, /left out \.env \(CHECK_TOKEN\)/)
    entries = entriesOf(file)
  })

  test('holds every file the dry run reads, hashed, and never node_modules or .env values', () => {
    assert.deepEqual(entries.map((e) => e.path).sort(), [
      'data/answer.txt',
      'evals/answer.eval.ts',
      'lib/task.ts',
      'manifest.json',
      'reeval.config.ts',
      'skills/guide/SKILL.md',
    ])
    const manifest = manifestOf(entries)
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.project, '')
    assert.equal(manifest.config, 'reeval.config.ts')
    assert.equal(manifest.git, null)
    for (const f of manifest.files) {
      const entry = entries.find((e) => e.path === f.path)
      assert.ok(entry?.type === 'file', f.path)
      assert.equal(f.sha256, sha256(entry.data), f.path)
    }
    assert.deepEqual(
      Object.fromEntries(manifest.files.map((f) => [f.path, f.kind])),
      {
        'data/answer.txt': 'read',
        'evals/answer.eval.ts': 'eval',
        'lib/task.ts': 'module',
        'reeval.config.ts': 'config',
        'skills/guide/SKILL.md': 'skill',
      },
    )
    assert.deepEqual(manifest.envFiles, [{ path: '.env', variables: ['CHECK_TOKEN'] }])
    assert.deepEqual(manifest.secrets, ['CHECK_TOKEN'])
    assert.ok(!JSON.stringify(manifest.plan).includes(dir), 'the plan names no host path')
    assert.ok(!gunzipSync(readFileSync(file)).includes(TOKEN), 'no secret value in the archive')
  })

  test('runs from a fresh directory as the project runs in place', async () => {
    const here = await runCli(dir, ['run'])
    assert.equal(here.code, 0, here.stderr)
    const tmp = extractRoot()
    const fresh = tempDir('bundle-fresh')
    const there = await runCli(fresh, ['run', '--bundle', file], {
      env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
    })
    assert.equal(there.code, 0, there.stderr + there.stdout)
    const extracted = /running .* in (\S+), where its \.reeval\/ stays/.exec(there.stdout)?.[1]
    assert.ok(extracted?.startsWith(tmp), there.stdout)
    assert.deepEqual(outcomes(readRun(extracted).run), outcomes(readRun(dir).run))
    const [attempt] = outcomes(readRun(extracted).run)[0]?.attempts ?? []
    assert.equal(attempt?.outcome, 'pass')
    assert.equal(attempt?.assertions.length, 2)
  })

  test('refuses a file that differs from its manifest, before any attempt', async () => {
    const tmp = extractRoot()
    const changed = entries.map((e) =>
      e.path === 'data/answer.txt' && e.type === 'file' ? { ...e, data: Buffer.from('41\n') } : e,
    )
    const bad = rewrite(changed, join(tempDir('bundle-bad'), 'differs.tar.gz'))
    const r = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', bad], {
      env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
    })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /doesn't match its manifest, so nothing ran:\n {2}differs: data\/answer\.txt/)
    assert.doesNotMatch(r.stdout, /Run:/)
    assert.deepEqual(
      readdirSync(tmp).filter((d) => d.startsWith('reeval-bundle-')),
      [],
      'the extracted copy is removed',
    )
  })

  test('refuses a bundle without a file its plan reads', async () => {
    const dropped = entries.filter((e) => e.path !== 'lib/task.ts')
    const bad = rewrite(dropped, join(tempDir('bundle-bad'), 'missing.tar.gz'), (m) => ({
      ...m,
      files: m.files.filter((f) => f.path !== 'lib/task.ts'),
    }))
    const r = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', bad], {
      env: { TMPDIR: extractRoot(), CHECK_TOKEN: TOKEN },
    })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /missing: lib\/task\.ts/)
    assert.doesNotMatch(r.stdout, /Run:/)
  })

  test('refuses a bundle that plans differently where it runs', async () => {
    const r = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', file], {
      env: { TMPDIR: extractRoot(), CHECK_TOKEN: TOKEN, BUNDLE_SECOND_EVAL: '1' },
    })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /doesn't plan here as it did where it was bundled, so nothing ran/)
    assert.match(r.stderr, /plan: totals\.attempts: 1 → 2/)
    assert.doesNotMatch(r.stdout, /Run:/)
  })

  test('in a monorepo, roots the bundle at the repository and installs from its lockfile', async () => {
    const repo = tempDir('bundle-repo')
    const app = join(repo, 'apps/evals')
    mkdirSync(app, { recursive: true })
    cpSync(fixture, app, { recursive: true })
    const pkg = { name: 'repo', version: '1.0.0', private: true }
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify(pkg)}\n`)
    writeFileSync(
      join(repo, 'package-lock.json'),
      `${JSON.stringify({ name: 'repo', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': pkg } })}\n`,
    )
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.reeval\nsandboxes\n')
    mkdirSync(join(repo, 'node_modules'))
    symlinkSync(pkgRoot, join(repo, 'node_modules/reeval'), 'dir')
    const git = (...args: string[]) =>
      spawnTool('git', args, { cwd: repo, env: baseEnv, encoding: 'utf8' })
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
    const out = join(tempDir('bundle-out'), 'repo.tar.gz')
    const tmp = extractRoot()
    const made = await runCli(app, ['bundle', '--out', out], { env: { TMPDIR: tmp } })
    assert.equal(made.code, 0, made.stderr)
    const manifest = manifestOf(entriesOf(out))
    assert.equal(manifest.project, 'apps/evals')
    assert.equal(manifest.config, 'apps/evals/reeval.config.ts')
    assert.equal(manifest.git?.dirty, false)
    assert.match(manifest.git?.commit ?? '', /^[0-9a-f]{40}$/)
    const kinds = Object.fromEntries(manifest.files.map((f) => [f.path, f.kind]))
    assert.equal(kinds['package-lock.json'], 'lockfile')
    assert.ok(kinds['package.json'], 'the install reads package.json')
    assert.equal(kinds['apps/evals/evals/answer.eval.ts'], 'eval')
    assert.ok(!manifest.files.some((f) => f.path.includes('node_modules')))
    const r = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', out], {
      env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
    })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /installing from package-lock\.json: npm ci/)
    assert.match(r.stdout, /1 passed/)
  })

  test('takes its filters and profile from the bundle', async () => {
    const r = await runCli(tempDir('bundle-fresh'), ['run', 'answer', '--tag', 'x', '--bundle', file])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /leave out filters, --tag/)
  })
})
