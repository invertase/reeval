import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { before, describe, test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { readTar, type TarEntry, writeTar } from '@reeval/sandbox-docker'
import { moveResumeState, planDifferences } from '../src/bundle/index.ts'
import type { BundleManifest } from '../src/bundle/types.ts'
import { UsageError } from '../src/errors.ts'
import type { RunRecord } from '../src/history/types.ts'
import { recordFileName } from '../src/ids.ts'
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
    gzipSync(
      writeTar([{ type: 'file', path: 'manifest.json', mode: 0o644, mtime: 0, data }, ...rest]),
    ),
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
    assert.deepEqual(manifest.features, [
      'heartbeat',
      'resume',
      'secrets-file',
      'vm-layout',
      'vm-waits',
    ])
    assert.equal(manifest.project, '')
    assert.equal(manifest.config, 'reeval.config.ts')
    assert.equal(manifest.git, null)
    for (const f of manifest.files) {
      const entry = entries.find((e) => e.path === f.path)
      assert.ok(entry?.type === 'file', f.path)
      assert.equal(f.sha256, sha256(entry.data), f.path)
    }
    assert.deepEqual(Object.fromEntries(manifest.files.map((f) => [f.path, f.kind])), {
      'data/answer.txt': 'read',
      'evals/answer.eval.ts': 'eval',
      'lib/task.ts': 'module',
      'reeval.config.ts': 'config',
      'skills/guide/SKILL.md': 'skill',
    })
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
    assert.equal(readRun(extracted).run.git, null, 'a bundle made outside git records no commit')
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
    assert.match(
      r.stderr,
      /doesn't match its manifest, so nothing ran:\n {2}differs: data\/answer\.txt/,
    )
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
    assert.match(r.stderr, /plan: totals\.attempts:\n {6}bundled: 1\n {6}here: {4}2\n/)
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

  test("a run from it records the bundled project's commit, branch, changes and author", async () => {
    const { dir: repo } = await fixtureProject()
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.reeval\nsandboxes\n.env\n')
    const git = (...args: string[]) =>
      spawnTool('git', args, { cwd: repo, env: baseEnv, encoding: 'utf8' }).stdout.trim()
    git('init', '-q', '-b', 'feature/bundled')
    git('config', 'user.name', 'Bundle Author')
    git('config', 'user.email', 'bundle@example.com')
    git('remote', 'add', 'origin', 'https://token@example.com/acme/evals.git')
    git('add', '.')
    git('commit', '-qm', 'init')
    const sha = git('rev-parse', 'HEAD')
    writeFileSync(
      join(repo, 'lib/task.ts'),
      `${readFileSync(join(repo, 'lib/task.ts'))}// edited\n`,
    )
    const out = join(tempDir('bundle-out'), 'git.tar.gz')
    const made = await runCli(repo, ['bundle', '--out', out])
    assert.equal(made.code, 0, made.stderr)
    const manifest = manifestOf(entriesOf(out))
    assert.equal(manifest.author, 'bundle-author')
    assert.deepEqual(
      { ...manifest.git, diffHash: undefined, commitTime: undefined },
      {
        commit: sha,
        dirty: true,
        branch: 'feature/bundled',
        diffHash: undefined,
        commitTime: undefined,
        shallow: false,
        remote: 'https://example.com/acme/evals.git',
      },
    )
    assert.match(manifest.git?.diffHash ?? '', /^[0-9a-f]{64}$/)

    const r = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', out], {
      env: { TMPDIR: extractRoot(), CHECK_TOKEN: TOKEN },
    })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    const extracted = /running .* in (\S+), where its \.reeval\/ stays/.exec(r.stdout)?.[1]
    assert.ok(extracted)
    const { run } = readRun(extracted)
    assert.match(run.runId, new RegExp(`^\\d{8}T\\d{6}Z_${sha.slice(0, 7)}_bundle-author_`))
    assert.equal(run.git?.sha, sha)
    assert.equal(run.git?.branch, 'feature/bundled')
    assert.equal(run.git?.dirty, true)
    assert.equal(run.git?.diffHash, manifest.git?.diffHash)
    assert.equal(run.git?.commitTime, manifest.git?.commitTime)
    assert.equal(run.git?.remote, 'https://example.com/acme/evals.git')
    assert.equal(run.git?.worktreePatch, null)
    assert.match(run.git?.worktreePatchNote ?? '', /run from a bundle/)
  })

  test('a run recorded into the history folder leaves the bundled project clean', async () => {
    const { dir: repo } = await fixtureProject()
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.reeval\nsandboxes\n.env\n')
    const git = (...args: string[]) =>
      spawnTool('git', args, { cwd: repo, env: baseEnv, encoding: 'utf8' }).stdout.trim()
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
    const recorded = await runCli(repo, ['run', '--record'])
    assert.equal(recorded.code, 0, recorded.stderr)
    assert.notEqual(git('status', '--porcelain'), '', 'the record is in the working tree')
    const out = join(tempDir('bundle-out'), 'clean.tar.gz')
    const made = await runCli(repo, ['bundle', '--out', out])
    assert.equal(made.code, 0, made.stderr)
    const manifest = manifestOf(entriesOf(out))
    assert.equal(manifest.git?.dirty, false)
    assert.equal(manifest.git?.diffHash, null)
    assert.doesNotMatch(made.stdout, /uncommitted changes/)
  })

  test("refuses a manifest whose commit isn't hex or whose author isn't a slug", async () => {
    const commit = 'a'.repeat(40)
    for (const [edit, refusal] of [
      [{ git: { commit: '../../x', dirty: false } }, /git\.commit: must be a git commit in hex/],
      [{ git: { commit, dirty: false }, author: '../Elsewhere' }, /author: must be lower-case/],
    ] as const) {
      const bad = rewrite(entries, join(tempDir('bundle-bad'), 'identity.tar.gz'), (m) => ({
        ...m,
        ...edit,
      }))
      const r = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', bad], {
        env: { TMPDIR: extractRoot(), CHECK_TOKEN: TOKEN },
      })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /isn't a bundle manifest/)
      assert.match(r.stderr, refusal)
      assert.doesNotMatch(r.stdout, /Run:/)
    }
  })

  test('refuses a bundle entry that is not a listed regular file, or a manifest path outside it', async () => {
    const at = tempDir('bundle-bad')
    const linked = rewrite(
      [...entries, { type: 'symlink', path: 'data/link', mode: 0o777, mtime: 0, target: '/etc' }],
      join(at, 'link.tar.gz'),
    )
    const tmp = extractRoot()
    const r = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', linked], {
      env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
    })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /not a regular file or a listed link: data\/link \(a link\)/)
    assert.deepEqual(
      readdirSync(tmp).filter((d) => d.startsWith('reeval-bundle-')),
      [],
    )
    for (const [edit, said] of [
      [
        (m: BundleManifest) => ({ ...m, files: [{ ...m.files[0], path: '../evil' }, ...m.files] }),
        /files\[0\]\.path: must be a path inside the bundle/,
      ],
      [(m: BundleManifest) => ({ ...m, project: '../..' }), /project: /],
      [
        (m: BundleManifest) => ({ ...m, links: [{ path: 'data/up', target: '../../etc' }] }),
        /links\[0\]\.target: must link to a path inside the bundle/,
      ],
      [(m: BundleManifest) => ({ ...m, config: '/etc/passwd' }), /config: must be a path inside/],
      [
        ({ secrets: _, ...m }: BundleManifest) => m as BundleManifest,
        /isn't a bundle manifest:\n {2}secrets: /,
      ],
    ] as const) {
      const bad = rewrite(entries, join(at, 'manifest.tar.gz'), edit as never)
      const refused = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', bad], {
        env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
      })
      assert.equal(refused.code, 2, refused.stderr)
      assert.match(refused.stderr, said)
    }
    assert.deepEqual(
      readdirSync(tmp).filter((d) => d.startsWith('reeval-bundle-')),
      [],
    )
  })

  test('refuses a chain of listed links that leaves the extract directory', async () => {
    const tmp = extractRoot()
    const keep: TarEntry = {
      type: 'file',
      path: 'a/b/c/d/e/f/keep',
      mode: 0o644,
      mtime: 0,
      data: Buffer.from('keep\n'),
    }
    const link = (path: string, target: string): TarEntry => ({
      type: 'symlink',
      path,
      mode: 0o777,
      mtime: 0,
      target,
    })
    const up = link('a/b/c/d/e/f/x', '../../../../..')
    /** The bundle with `extra` links, each listed in the manifest and, unless `unplanned`, the plan. */
    const chained = (extra: TarEntry[], unplanned: string[] = []) =>
      rewrite(
        [...entries, keep, up, ...extra],
        join(tempDir('bundle-bad'), 'chain.tar.gz'),
        (m) => {
          const all = [up, ...extra] as Array<TarEntry & { type: 'symlink' }>
          const plan = m.plan as { inputs: Array<Record<string, unknown>> }
          return {
            ...m,
            files: [
              ...m.files,
              { path: keep.path, kind: 'skill', sha256: sha256(Buffer.from('keep\n')), size: 5 },
            ],
            links: all.map((l) => ({ path: l.path, target: l.target })),
            plan: {
              ...m.plan,
              inputs: [
                ...plan.inputs,
                ...all
                  .filter((l) => !unplanned.includes(l.path))
                  .map((l) => ({ path: l.path, kind: 'skill', evals: [], symlinkTo: l.target })),
              ],
            },
          }
        },
      )
    const host = '../../../../../../tmp/adv/host.env'
    const cases: Array<[string, RegExp]> = [
      [
        chained([link('.env', `a/b/c/d/e/f/x/${host}`)]),
        /a link where the run loads a \.env file: \.env/,
      ],
      [
        chained([link('notes.md', `a/b/c/d/e/f/x/${host}`)]),
        /a link through another link: notes\.md → a\/b\/c\/d\/e\/f\/x\//,
      ],
      [
        chained([link('a/b/c/d/e/f/other', 'keep')], ['a/b/c/d/e/f/other']),
        /a link its plan doesn't list: a\/b\/c\/d\/e\/f\/other/,
      ],
      [chained([link('a/b/c/d/e/f/gone', 'missing')]), /a link to nothing: a\/b\/c\/d\/e\/f\/gone/],
    ]
    for (const [bad, said] of cases) {
      const r = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', bad], {
        env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
      })
      assert.equal(r.code, 2, r.stderr + r.stdout)
      assert.match(r.stderr, said)
      assert.doesNotMatch(r.stdout, /Run:/)
    }
    assert.deepEqual(
      readdirSync(tmp).filter((d) => d.startsWith('reeval-bundle-')),
      [],
    )
  })

  test('reeval clean --bundles removes the copies whose run has ended', async () => {
    const tmp = tempDir('bundle-tmp')
    const ended = join(tmp, 'reeval-bundle-999999999-abc')
    const running = join(tmp, `reeval-bundle-${process.pid}-abc`)
    mkdirSync(join(ended, '.reeval'), { recursive: true })
    mkdirSync(running)
    const r = await runCli(dir, ['clean', '--bundles'], { env: { TMPDIR: tmp } })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Removed 1 extracted bundle/)
    assert.ok(!existsSync(ended))
    assert.ok(existsSync(running), "a running bundle's copy stays")
  })

  test('--resume continues the run whose .reeval/ state is in the current directory', async () => {
    const tmp = extractRoot()
    const first = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', file, '--events'], {
      env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
    })
    assert.equal(first.code, 0, first.stderr + first.stdout)
    const extracted = /running .* in (\S+), where its \.reeval\/ stays/.exec(first.stdout)?.[1]
    assert.ok(extracted, first.stdout)
    const { run } = readRun(extracted)
    const state = tempDir('bundle-state')
    const runs = join(state, '.reeval', 'runs')
    mkdirSync(runs, { recursive: true })
    cpSync(join(extracted, '.reeval', 'runs', run.runId), join(runs, run.runId), {
      recursive: true,
    })
    const stream = join('.reeval', 'events', `${run.runId}.ndjson`)
    cpSync(join(extracted, stream), join(state, stream))
    // Staging and the scratch record both, as a copy from another machine leaves them.
    const staging = join(state, '.reeval', 'staging', run.runId)
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'holder'), '1\nanother-machine\n')
    // That machine's live.json, beating a second ago: the state is here now, so it doesn't block.
    writeFileSync(
      join(staging, 'live.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        runId: run.runId,
        startedAt: run.startedAt,
        pid: 1,
        host: 'another-machine',
        heartbeatAt: new Date(Date.now() - 1_000).toISOString(),
        phase: 'running',
        planned: 1,
        counts: { done: 0, passed: 0, failed: 0, errored: 0, skipped: 0, running: 0 },
        attempts: [],
        invocation: run.invocation,
      })}\n`,
    )
    writeFileSync(
      join(runs, `${run.runId}.json`),
      JSON.stringify({ ...run, status: 'interrupted' }),
    )
    const r = await runCli(state, ['run', '--bundle', file, '--resume', run.runId], {
      env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
    })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    const resumed = /resuming run \S+ from .* in (\S+), where its \.reeval\/ stays/.exec(
      r.stdout,
    )?.[1]
    assert.ok(resumed && resumed !== extracted, r.stdout)
    assert.ok(!existsSync(join(runs, `${run.runId}.json`)), 'the state moved out')
    assert.ok(!existsSync(join(runs, run.runId)))
    const after = readRun(resumed).run
    assert.equal(after.runId, run.runId)
    assert.equal(after.status, 'complete')
    const [kept] = after.evals[0]?.attempts ?? []
    assert.equal(kept?.outcome, 'pass')
    assert.equal(kept?.startedAt, run.evals[0]?.attempts[0]?.startedAt, 'the attempt was kept')
    assert.ok(!existsSync(join(state, stream)), 'the event stream moved too')
    assert.ok(!existsSync(staging))
    assert.ok(!existsSync(join(resumed, '.reeval', 'staging', run.runId)), 'assembled')
    const lines = readFileSync(join(resumed, stream), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string })
    assert.deepEqual(
      lines.filter((l) => l.type === 'header' || l.type === 'exit').map((l) => l.type),
      ['header', 'exit', 'header', 'exit'],
      'the resume appends a new header after the first exit',
    )
    assert.match(readFileSync(join(resumed, stream), 'utf8'), /"resumed":1/)
  })

  test('--events-file resolves from the current directory, not the extracted project', async () => {
    const here = tempDir('bundle-fresh')
    const r = await runCli(here, ['run', '--bundle', file, '--events-file', 'events.ndjson'], {
      env: { TMPDIR: extractRoot(), CHECK_TOKEN: TOKEN },
    })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(readFileSync(join(here, 'events.ndjson'), 'utf8'), /^\{"type":"header"/)
  })

  test('--resume refuses a run with no state here, or no id, before extracting', async () => {
    const tmp = extractRoot()
    const id = '20260101T000000Z_nogit_gone_aaaa'
    const none = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', file, '--resume', id], {
      env: { TMPDIR: tmp },
    })
    assert.equal(none.code, 2, none.stderr + none.stdout)
    assert.match(
      none.stderr,
      /No state for run \S+ in .*\.reeval: --bundle with --resume continues/,
    )
    const bare = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', file, '--resume'], {
      env: { TMPDIR: tmp },
    })
    assert.equal(bare.code, 2, bare.stderr + bare.stdout)
    assert.match(bare.stderr, /--bundle with --resume continues one run: pass its id/)
    const path = await runCli(
      tempDir('bundle-fresh'),
      ['run', '--bundle', file, '--resume', `../${id}`],
      { env: { TMPDIR: tmp } },
    )
    assert.equal(path.code, 2, path.stderr + path.stdout)
    assert.match(path.stderr, /--resume \.\.\/\S+ isn't a run id/)
    assert.deepEqual(
      readdirSync(tmp).filter((d) => d.startsWith('reeval-bundle-')),
      [],
    )
  })

  test('--resume refuses a run still running from here, and leaves its state where it is', async () => {
    const tmp = extractRoot()
    const here = tempDir('bundle-live')
    const id = '20260101T000000Z_nogit_live_aaaa'
    const staging = join(here, '.reeval', 'staging', id)
    mkdirSync(join(staging, 'evals'), { recursive: true })
    // This test process: alive on this host, and not the reeval it starts.
    writeFileSync(join(staging, 'holder'), `${process.pid}\n${hostname()}\n`)
    writeFileSync(join(staging, 'evals', 'a.json'), '{}\n')
    const r = await runCli(here, ['run', '--bundle', file, '--resume', id], {
      env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
    })
    assert.equal(r.code, 2, r.stderr + r.stdout)
    assert.match(r.stderr, /run \S+ is still running from \S+\. Wait for it to finish or stop/)
    assert.ok(existsSync(join(staging, 'evals', 'a.json')), 'the live run keeps its state')
    assert.ok(existsSync(join(staging, 'holder')))
    assert.deepEqual(
      readdirSync(tmp).filter((d) => d.startsWith('reeval-bundle-')),
      [],
    )
  })

  test("--resume keeps a staged pass and the scratch record's, and runs the rest again", async () => {
    const three = join(tempDir('bundle-out'), 'three.tar.gz')
    const made = await runCli(dir, ['bundle', '--runs', '3', '--out', three])
    assert.equal(made.code, 0, made.stderr)
    const tmp = extractRoot()
    const first = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', three], {
      env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN },
    })
    assert.equal(first.code, 0, first.stderr + first.stdout)
    const extracted = /running .* in (\S+), where its \.reeval\/ stays/.exec(first.stdout)?.[1]
    assert.ok(extracted, first.stdout)
    const { run } = readRun(extracted)
    const [one, two, rest] = run.evals[0]?.attempts ?? []
    assert.ok(one && two && rest)
    // The scratch record holds attempt 1, the staging attempt 2, and nothing holds attempt 3.
    const state = tempDir('bundle-state')
    const runs = join(state, '.reeval', 'runs')
    mkdirSync(runs, { recursive: true })
    const evals = run.evals.map((e) => ({ ...e, attempts: e.attempts.slice(0, 1) }))
    writeFileSync(
      join(runs, `${run.runId}.json`),
      JSON.stringify({ ...run, status: 'interrupted', evals }),
    )
    const staged = join(state, '.reeval', 'staging', run.runId, 'evals')
    mkdirSync(staged, { recursive: true })
    writeFileSync(
      join(staged, recordFileName(two.key)),
      JSON.stringify({
        outcome: 'pass',
        error: null,
        startedAt: two.startedAt,
        turns: [],
        diff: null,
        checks: [],
        judgements: [],
        timings: { setupMs: 0, agentMs: 0, diffMs: 0, checksMs: 0, judgeMs: 0 },
      }),
    )
    const events = join(state, 'events.ndjson')
    const r = await runCli(
      state,
      ['run', '--bundle', three, '--resume', run.runId, '--events-file', events],
      { env: { TMPDIR: tmp, CHECK_TOKEN: TOKEN } },
    )
    assert.equal(r.code, 0, r.stderr + r.stdout)
    const resumed = /resuming run \S+ from .* in (\S+), where its \.reeval\/ stays/.exec(
      r.stdout,
    )?.[1]
    assert.ok(resumed, r.stdout)
    const after = readRun(resumed).run
    assert.equal(after.status, 'complete')
    const attempts = after.evals[0]?.attempts ?? []
    assert.deepEqual(
      attempts.map((a) => a.outcome),
      ['pass', 'pass', 'pass'],
    )
    assert.equal(attempts[0]?.startedAt, one.startedAt, "the scratch record's pass is kept")
    assert.equal(attempts[1]?.startedAt, two.startedAt, 'the staged pass is kept')
    assert.notEqual(attempts[2]?.startedAt, rest.startedAt, 'attempt 3 ran again')
    assert.match(readFileSync(events, 'utf8'), /"resumed":2/)
  })

  test('--resume moves the state all or nothing, and refuses when a move fails', () => {
    const from = tempDir('bundle-state')
    const id = '20260101T000000Z_nogit_split_aaaa'
    const staging = join(from, '.reeval', 'staging', id)
    mkdirSync(join(staging, 'evals'), { recursive: true })
    writeFileSync(join(staging, 'evals', 'a.json'), '{}\n')
    mkdirSync(join(from, '.reeval', 'runs'))
    writeFileSync(join(from, '.reeval', 'runs', `${id}.json`), '{}\n')
    const project = tempDir('bundle-project')
    mkdirSync(join(project, '.reeval'))
    // The record's folder can't be made, after the staging has moved.
    writeFileSync(join(project, '.reeval', 'runs'), '')
    assert.throws(
      () => moveResumeState(from, project, id),
      (e: unknown) =>
        e instanceof UsageError &&
        /^Couldn't move run \S+'s state into .*: .*\. The state is still in /.test(e.message),
    )
    assert.ok(existsSync(join(staging, 'evals', 'a.json')), 'the staging moved back')
    assert.ok(existsSync(join(from, '.reeval', 'runs', `${id}.json`)))
    assert.ok(!existsSync(join(project, '.reeval', 'staging', id)))
  })

  test('takes its filters and profile from the bundle', async () => {
    const r = await runCli(tempDir('bundle-fresh'), [
      'run',
      'answer',
      '--tag',
      'x',
      '--bundle',
      file,
    ])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /leave out filters, --tag/)
  })
})

/** A GitHub token's shape, made here so no file in the repository holds one. */
const GITHUB_TOKEN = `ghp_${'a1B2'.repeat(9)}`

/**
 * The fixture project with `files` (an expression over `file` and `directory`) as its
 * environment's files, `skills` in place of its own when given, and each of `extra` written.
 */
async function variant(
  extra: Record<string, string>,
  { files, skills }: { files?: string; skills?: string } = {},
): Promise<string> {
  const { dir } = await fixtureProject()
  const configFile = join(dir, 'reeval.config.ts')
  let config = readFileSync(configFile, 'utf8').replace(
    '({ skill, secret }) => ({',
    `({ skill, secret, file, directory }) => ({${files ? `\n    files: ${files},` : ''}`,
  )
  if (skills) config = config.replace("[skill.local('./skills/guide')]", skills)
  writeFileSync(configFile, config)
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

async function bundleOf(dir: string, env: Record<string, string> = {}) {
  const out = join(tempDir('bundle-out'), 'variant.tar.gz')
  const r = await runCli(dir, ['bundle', '--out', out], { env })
  return { ...r, out, written: existsSync(out) }
}

describe('what reeval bundle refuses to carry', () => {
  test('a .env the run copies into the sandbox, from directory() or file()', async () => {
    const listed = await bundleOf(
      await variant(
        { 'notes/a.md': 'hi\n', 'notes/.env': 'NOTE_KEY=x\n' },
        { files: "directory('./notes', { into: 'notes' })" },
      ),
    )
    assert.equal(listed.code, 2, listed.stderr)
    assert.match(
      listed.stderr,
      /copies a \.env file into the sandbox[^\n]*\n {2}notes\/\.env \(file\)/,
    )
    assert.ok(!listed.written)
    const loaded = await bundleOf(
      await variant({}, { files: "{ 'settings.env': file('./.env') }" }),
    )
    assert.equal(loaded.code, 2, loaded.stderr)
    assert.match(loaded.stderr, /\n {2}\.env \(file\): leave it out of the environment's files/)
    assert.ok(!loaded.written)
  })

  test('a file() link to a host file outside the bundle root', async () => {
    const host = tempDir('bundle-host')
    const key =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nhostkeymaterial\n-----END OPENSSH PRIVATE KEY-----\n'
    writeFileSync(join(host, 'id_ed25519'), key, { mode: 0o600 })
    const dir = await variant({}, { files: "{ 'key': file('./key') }" })
    symlinkSync(join(host, 'id_ed25519'), join(dir, 'key'))
    const r = await bundleOf(dir)
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /through 1 link to files outside the bundle root[^:]*: key\b/)
    assert.ok(!r.written)
    assert.doesNotMatch(r.stderr, /hostkeymaterial/)
  })

  test('a secret-looking value in any file it would carry, a skill note or .envrc', async () => {
    const note = await bundleOf(
      await variant({ 'skills/guide/notes.md': `Use ${GITHUB_TOKEN} for the API.\n` }),
    )
    assert.equal(note.code, 2, note.stderr)
    assert.match(
      note.stderr,
      /would carry secrets[\s\S]*skills\/guide\/notes\.md line 1: GitHub token/,
    )
    assert.ok(!note.stderr.includes(GITHUB_TOKEN), 'the refusal never prints the value')
    assert.ok(!note.written)
    const envrc = await bundleOf(
      await variant({ 'skills/guide/.envrc': `export GH_TOKEN=${GITHUB_TOKEN}\n` }),
    )
    assert.equal(envrc.code, 2, envrc.stderr)
    assert.match(
      envrc.stderr,
      /skills\/guide\/\.envrc \(skill\): leave it out of the skill with skill\.local\(\)'s exclude/,
    )
    assert.doesNotMatch(envrc.stderr, /directory\(\)/)
    assert.ok(!envrc.stderr.includes(GITHUB_TOKEN))
    assert.ok(!envrc.written)
  })

  test("a registry credential in a package manager's settings, but not a variable reference", async () => {
    for (const [name, text, setting] of [
      ['.yarnrc.yml', 'npmAuthToken: "abcd1234efgh5678"\n', 'npmAuthToken'],
      [
        'bunfig.toml',
        '[install]\nregistry = { url = "https://r.test/", token = "abcd1234" }\n',
        'token',
      ],
      ['.npmrc', '//registry.npmjs.org/:_authToken=abcd1234efgh5678\n', '_authToken'],
    ]) {
      const r = await bundleOf(await variant({ [name]: text }))
      assert.equal(r.code, 2, `${name}: ${r.stderr}`)
      assert.match(
        r.stderr,
        new RegExp(`${name.replace('.', '\\.')}: ${setting} holds a registry credential`),
      )
      assert.ok(!r.written, name)
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: npm expands the .npmrc's ${NPM_TOKEN}
    const npmrc = '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n'
    const referenced = await bundleOf(await variant({ '.npmrc': npmrc }))
    assert.equal(referenced.code, 0, referenced.stderr)
    const files = manifestOf(entriesOf(referenced.out)).files
    assert.equal(files.find((f) => f.path === '.npmrc')?.kind, 'install')
  })

  test("a file holding a secret's value or a loaded .env variable's", async () => {
    const secret = await bundleOf(await variant({ 'skills/guide/notes.md': `token: ${TOKEN}\n` }))
    assert.equal(secret.code, 2, secret.stderr)
    assert.match(secret.stderr, /skills\/guide\/notes\.md: holds the value of CHECK_TOKEN/)
    assert.ok(!secret.stderr.includes(TOKEN))
    assert.ok(!secret.written)
    const dir = await variant({ 'skills/guide/notes.md': 'see Zq9-unrelated-value\n' })
    writeFileSync(join(dir, '.env'), `CHECK_TOKEN=${TOKEN}\nOTHER=Zq9-unrelated-value\n`)
    const other = await bundleOf(dir)
    assert.equal(other.code, 2, other.stderr)
    assert.match(other.stderr, /notes\.md: holds the value of OTHER/)
  })

  test("a host secret's value once, though the scan would find it too", async () => {
    const dir = await variant({ 'skills/guide/notes.md': `key: ${GITHUB_TOKEN}\n` })
    writeFileSync(join(dir, '.env'), `CHECK_TOKEN=${GITHUB_TOKEN}\n`)
    const r = await bundleOf(dir, { CHECK_TOKEN: GITHUB_TOKEN })
    assert.equal(r.code, 2, r.stderr)
    const said = r.stderr.split('\n').filter((l) => l.includes('notes.md'))
    assert.deepEqual(said, ['  skills/guide/notes.md: holds the value of CHECK_TOKEN'])
  })

  test('a local git repository a skill, plugin or marketplace clones', async () => {
    const dir = await variant(
      { 'repo/guide/SKILL.md': '---\nname: guide\ndescription: d\n---\n' },
      {
        skills: "[skill.git('./repo')]",
      },
    )
    const git = (...args: string[]) =>
      spawnTool('git', args, { cwd: join(dir, 'repo'), env: baseEnv, encoding: 'utf8' })
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
    const r = await bundleOf(dir)
    assert.equal(r.code, 2, r.stderr)
    assert.match(
      r.stderr,
      /can't carry a local git repository, whose history reeval clones: repo \(skill\)/,
    )
    assert.ok(!r.written)
  })

  test('links under a walked directory: outside the root refused, a loop walked once', async () => {
    const root = tempDir('bundle-walk')
    const host = tempDir('bundle-host')
    writeFileSync(join(host, 'secret.txt'), 'host\n')
    mkdirSync(join(root, 'dir/sub'), { recursive: true })
    writeFileSync(join(root, 'dir/sub/a.md'), 'a\n')
    writeFileSync(join(root, 'top.md'), 'top\n')
    symlinkSync('..', join(root, 'dir/sub/up'))
    symlinkSync('../top.md', join(root, 'dir/alias.md'))
    symlinkSync(host, join(root, 'dir/host'))
    const { collect } = await import('../src/bundle/index.ts')
    const found = await collect([{ abs: join(root, 'dir'), kind: 'file' }], root)
    assert.deepEqual(found.outside, ['dir/host'])
    assert.deepEqual([...found.kinds.keys()].map((p) => p.slice(root.length + 1)).sort(), [
      'dir/alias.md',
      'dir/sub/a.md',
    ])
  })
})

describe('symbolic links in a skill folder', () => {
  test('are carried as links to their targets in the bundle, and run from it', async () => {
    const dir = await variant({ 'skills/guide/notes.md': 'notes\n' })
    symlinkSync('notes.md', join(dir, 'skills/guide/alias.md'))
    mkdirSync(join(dir, 'skills/shared'))
    writeFileSync(join(dir, 'skills/shared/tip.md'), 'tip\n')
    symlinkSync('../shared', join(dir, 'skills/guide/shared'))
    const made = await bundleOf(dir)
    assert.equal(made.code, 0, made.stderr)
    assert.match(made.stdout, /and 2 links/)
    const archive = entriesOf(made.out)
    const manifest = manifestOf(archive)
    assert.deepEqual(manifest.links, [
      { path: 'skills/guide/alias.md', target: 'notes.md' },
      { path: 'skills/guide/shared', target: '../shared' },
    ])
    assert.deepEqual(
      archive
        .filter((e) => e.type === 'symlink')
        .map((e) => [e.path, e.type === 'symlink' && e.target]),
      [
        ['skills/guide/alias.md', 'notes.md'],
        ['skills/guide/shared', '../shared'],
      ],
    )
    assert.ok(manifest.files.some((f) => f.path === 'skills/shared/tip.md'))
    const r = await runCli(tempDir('bundle-fresh'), ['run', '--bundle', made.out], {
      env: { TMPDIR: extractRoot(), CHECK_TOKEN: TOKEN },
    })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    const extracted = /running .* in (\S+), where its \.reeval\/ stays/.exec(r.stdout)?.[1] ?? ''
    assert.equal(readlinkSync(join(extracted, 'skills/guide/alias.md')), 'notes.md')
    assert.equal(readlinkSync(join(extracted, 'skills/guide/shared')), '../shared')
  })

  test('still refuse a link whose target is outside the bundle root', async () => {
    const host = tempDir('bundle-host')
    writeFileSync(join(host, 'secret.md'), 'host\n')
    const dir = await variant({})
    symlinkSync(join(host, 'secret.md'), join(dir, 'skills/guide/secret.md'))
    const r = await bundleOf(dir)
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /secret\.md/)
    assert.ok(!r.written)
  })
})

describe("a bundle's plan where it runs", () => {
  const cell = (effort: string | null) => ({ harness: 'cursor:composer-2.5', effort, runs: 1 })
  const plan = (notes: string[], effort: string | null = null, more: string[] = []) => ({
    totals: { evals: 1, attempts: 1 },
    evals: [{ id: 'e', notes: [...notes, ...more], cells: [cell(effort)] }],
  })
  const manifest = (p: ReturnType<typeof plan>) => ({ project: '', plan: p }) as BundleManifest
  const differs = (bundled: ReturnType<typeof plan>, here: ReturnType<typeof plan>) =>
    planDifferences(manifest(bundled), here as Parameters<typeof planDifferences>[1])
  const NONE =
    "effort: cursor:composer-2.5 none (Cursor's model catalog lists no effort for composer-2.5)"
  const FAILED =
    "effort: cursor:composer-2.5 not checked against Cursor's model catalog (its request failed: HTTP 401)"
  const TAKES = 'effort: cursor:composer-2.5 none (params.fast sets it)'
  const NO_KEY =
    "effort: cursor:composer-2.5 not checked against Cursor's model catalog (CURSOR_API_KEY isn't set)"

  test("ignores the efforts Cursor's model catalog decides where either side couldn't read it", () => {
    assert.deepEqual(differs(plan([NONE]), plan([FAILED])), [])
    assert.deepEqual(differs(plan([NO_KEY]), plan([], 'medium')), [])
    assert.deepEqual(differs(plan([], 'medium'), plan([FAILED])), [])
  })

  test('still compares the efforts both sides read, and every other note', () => {
    assert.equal(differs(plan([NONE]), plan([TAKES])).length, 1)
    assert.equal(differs(plan([NONE], null), plan([], 'medium')).length, 2)
    assert.deepEqual(differs(plan([NO_KEY], null, ['a']), plan([FAILED], null, ['b'])), [
      'plan: evals[0].notes[0]:\n      bundled: "a"\n      here:    "b"',
    ])
  })

  test('shows both values whole, or from just before they differ', () => {
    const [line] = differs(plan([NONE]), plan([TAKES]))
    assert.ok(line?.includes(JSON.stringify(NONE)), line)
    assert.ok(line?.includes(JSON.stringify(TAKES)), line)
    const long = 'x'.repeat(600)
    const [cut] = differs(plan([`${long} where it was bundled`]), plan([`${long} here`]))
    assert.match(cut ?? '', /bundled: "…x+ where it was bundled"\n {6}here: {4}"…x+ here"/)
  })
})
