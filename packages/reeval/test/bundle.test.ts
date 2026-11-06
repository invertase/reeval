import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
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
    assert.match(r.stderr, /not a regular file: data\/link \(a link\)/)
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

async function bundleOf(dir: string) {
  const out = join(tempDir('bundle-out'), 'variant.tar.gz')
  const r = await runCli(dir, ['bundle', '--out', out])
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
    assert.match(listed.stderr, /copies notes\/\.env into the sandbox/)
    assert.ok(!listed.written)
    // The plan lists a loaded .env that file() also copies once, as the env-file it loads: left
    // out by name like any .env, so its value still never reaches the archive.
    const given = await bundleOf(await variant({}, { files: "{ 'settings.env': file('./.env') }" }))
    assert.equal(given.code, 0, given.stderr)
    assert.ok(!gunzipSync(readFileSync(given.out)).includes(TOKEN))
    assert.deepEqual(manifestOf(entriesOf(given.out)).envFiles, [
      { path: '.env', variables: ['CHECK_TOKEN'] },
    ])
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
    assert.match(envrc.stderr, /skills\/guide\/\.envrc/)
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
