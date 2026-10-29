// Snapshots: the tar reader and writer, what an archive leaves out and masks, each form's cap, and
// through the CLI, every attempt's final workspace in its run directory by default, after each
// turn with 'turns', as a tar.gz with compress, merged field by field down the cascade, off at
// each level, printed for a failed attempt, never recorded into the history, and pruned.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { streamPreview } from '../../sandbox-docker/src/trace.ts'
import { archiveWorkspace, cleanArchive, takeSnapshot } from '../src/attempt/snapshot.ts'
import type { Attempt } from '../src/attempt/state.ts'
import { optionsHash } from '../src/eval-source.ts'
import type { AttemptRecord } from '../src/history/types.ts'
import type { Sandbox } from '../src/sandbox/index.ts'
import {
  extractTar,
  readTar,
  readTree,
  safeTarPath,
  type TarEntry,
  writeTar,
} from '../src/tarball.ts'
import { fakeConfig, project, readRun, runCli, tempDir } from './helpers.ts'

const SECRET = `ghp_${'a1B2'.repeat(9)}`
const file = (path: string, data: string | Buffer): TarEntry => ({
  type: 'file',
  path,
  mode: 0o644,
  mtime: 1_700_000_000,
  data: Buffer.from(data),
})

describe('tar', () => {
  test('writeTar and readTar round-trip long and non-ASCII paths, dirs and symlinks', () => {
    const long = `${'deep/'.repeat(40)}file.txt`
    const entries: TarEntry[] = [
      { type: 'dir', path: 'src', mode: 0o755, mtime: 1_700_000_000 },
      file('src/app.js', 'export {}\n'),
      file(long, 'x'),
      file('docs/naïve-ünïcode.md', '# hi\n'),
      { type: 'symlink', path: 'link', mode: 0o777, mtime: 1_700_000_000, target: 'src/app.js' },
    ]
    const back = readTar(writeTar(entries))
    assert.deepEqual(
      back.map((e) => [e.type, e.path]),
      entries.map((e) => [e.type, e.path]),
    )
    const app = back.find((e) => e.path === 'src/app.js')
    assert.equal(app?.type === 'file' && app.data.toString(), 'export {}\n')
    const link = back.find((e) => e.path === 'link')
    assert.equal(link?.type === 'symlink' && link.target, 'src/app.js')
  })

  test("reads the system tar's archive, GNU or BSD", (t) => {
    const dir = tempDir('tar-system')
    mkdirSync(join(dir, 'src', `${'n'.repeat(120)}`), { recursive: true })
    writeFileSync(join(dir, 'src', 'n'.repeat(120), 'a.txt'), 'deep\n')
    writeFileSync(join(dir, 'top.txt'), 'top\n')
    let tar: Buffer
    try {
      tar = execFileSync('tar', ['-cf', '-', '.'], { cwd: dir, maxBuffer: 1 << 24 })
    } catch {
      t.skip('no tar on PATH')
      return
    }
    const files = readTar(tar)
      .filter((e) => e.type === 'file')
      .map((e) => e.path)
      .sort()
    assert.deepEqual(files, [`src/${'n'.repeat(120)}/a.txt`, 'top.txt'])
  })

  test('safeTarPath refuses absolute and climbing paths', () => {
    assert.equal(safeTarPath('./a/./b'), 'a/b')
    for (const bad of ['/etc/passwd', '../up', 'a/../../b', 'C:/x', 'a\\b', '.', '']) {
      assert.equal(safeTarPath(bad), null, bad)
    }
  })

  test('extractTar writes nothing through a symlink or over an existing file', async () => {
    const dir = tempDir('tar-extract')
    const outside = tempDir('tar-outside')
    const skipped = await extractTar(
      [
        { type: 'symlink', path: 'out', mode: 0o777, mtime: 0, target: outside },
        file('out/planted.txt', 'no'),
        file('ok.txt', 'yes'),
        file('ok.txt', 'again'),
      ],
      dir,
    )
    assert.deepEqual(readdirSync(outside), [], 'nothing written outside')
    assert.equal(readFileSync(join(dir, 'ok.txt'), 'utf8'), 'yes')
    assert.ok(skipped.includes('out/planted.txt'), skipped.join(', '))
    assert.ok(skipped.includes('ok.txt'), skipped.join(', '))
    if (process.platform !== 'win32') assert.equal(await readlink(join(dir, 'out')), outside)
  })

  test('extractTar skips an entry it cannot write instead of throwing', async () => {
    const dir = tempDir('tar-clash')
    const skipped = await extractTar(
      [file('x', 'a file'), { type: 'dir', path: 'x', mode: 0o755, mtime: 0 }, file('x/y', 'no')],
      dir,
    )
    assert.deepEqual(skipped, ['x', 'x/y'])
    assert.equal(readFileSync(join(dir, 'x'), 'utf8'), 'a file')
  })

  test('readTree reads a directory back as entries, keeping a symlink as one', async (t) => {
    const dir = tempDir('tar-tree')
    await extractTar(
      [
        file('src/app.js', 'export {}\n'),
        { type: 'symlink', path: 'link', mode: 0o777, mtime: 0, target: '/etc' },
      ],
      dir,
    )
    if (!existsSync(join(dir, 'link'))) t.diagnostic('no symlink on this platform')
    const tree = await readTree(dir)
    const app = tree.find((e) => e.path === 'src/app.js')
    assert.equal(app?.type === 'file' && app.data.toString(), 'export {}\n')
    assert.ok(tree.some((e) => e.path === 'src' && e.type === 'dir'))
    const link = tree.find((e) => e.path === 'link')
    // Windows stores an absolute target on the current drive, as `D:\etc`.
    const target = process.platform === 'win32' ? resolve('/etc') : '/etc'
    if (link) assert.equal(link.type === 'symlink' && link.target, target)
  })

  test('readTar stops at a header whose size is not a whole number of bytes', () => {
    const pax = (size: string) => {
      const record = ` size=${size}\n`
      const body = `${record.length + 2}${record}`
      const tar = writeTar([file('PaxHeader', body)])
      tar[156] = 'x'.charCodeAt(0)
      let sum = 0
      tar.fill(0x20, 148, 156)
      for (const byte of tar.subarray(0, 512)) sum += byte
      Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(tar, 148)
      return tar.subarray(0, 1024)
    }
    const tar = Buffer.concat([pax('-1024'), pax('-1024'), writeTar([file('a', 'a')])])
    assert.deepEqual(readTar(tar), [])
  })
})

describe('cleanArchive', () => {
  test('leaves out dependency and cache directories, masks text, drops binaries with secrets', () => {
    const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SECRET)])
    const { entries, masked, dropped, excluded } = cleanArchive(
      writeTar([
        file('src/app.js', 'export {}\n'),
        file('node_modules/dep/index.js', 'x'),
        file('pkg/node_modules/dep/index.js', 'x'),
        file('.git/HEAD', 'ref: refs/heads/main\n'),
        file('.cache/tool/blob', 'x'),
        file('.env', `GITHUB_TOKEN=${SECRET}\n`),
        file('bin/blob', binary),
        file('bin/plain', Buffer.from([0, 1, 2, 3])),
      ]),
    )
    assert.deepEqual(entries.map((e) => e.path).sort(), ['.env', 'bin/plain', 'src/app.js'])
    assert.deepEqual(excluded.sort(), ['.cache/', '.git/', 'node_modules/', 'pkg/node_modules/'])
    assert.deepEqual(masked, ['.env'])
    assert.deepEqual(dropped, ['bin/blob'])
    const named = cleanArchive(
      writeTar([
        file(`keys/${SECRET}.txt`, 'x'),
        { type: 'symlink', path: 'link', mode: 0o777, mtime: 0, target: `/tmp/${SECRET}` },
      ]),
    )
    assert.deepEqual(named.entries, [])
    assert.deepEqual(named.dropped, ['keys/[REDACTED].txt', 'link'])
    const env = entries.find((e) => e.path === '.env')
    assert.ok(env?.type === 'file' && !env.data.toString().includes(SECRET))
  })
})

/** A sandbox on the host whose workspace is `dir`, enough for archiveWorkspace. */
const hostBox = (dir: string, env: NodeJS.ProcessEnv = process.env): Sandbox =>
  ({
    workdir: dir,
    execOwn: async (command: string) => {
      try {
        const stdout = execFileSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          maxBuffer: 1 << 26,
          env,
        })
        return { exitCode: 0, stdout, stderr: '' }
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string }
        return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
      }
    },
  }) as unknown as Sandbox

const LIMITS = { dir: 2 ** 20, tar: 2 ** 20, raw: 2 ** 20 }

/** Enough of an attempt for takeSnapshot. */
const attemptFor = (dir: string, signal: AbortSignal, compress = false) =>
  ({
    spec: { snapshot: { when: true, compress } },
    signal,
    snapshotDir: join(dir, 'staged'),
    record: {},
  }) as unknown as Attempt

describe('archiveWorkspace', {
  skip: process.platform === 'win32' && 'runs the archive commands in sh, which Windows lacks',
}, () => {
  test('takes a snapshot under its cap, and none over it, naming the size', async () => {
    const dir = tempDir('archive-cap')
    mkdirSync(join(dir, 'node_modules/dep'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/dep/big.bin'), Buffer.alloc(1 << 20, 7))
    writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
    const signal = new AbortController().signal
    const small = await archiveWorkspace(hostBox(dir), signal, false)
    assert.equal(small.taken.skipped, null)
    assert.equal(small.taken.files, 1)
    assert.deepEqual(small.taken.excluded, ['node_modules/'])
    assert.deepEqual(
      small.entries?.filter((e) => e.type === 'file').map((e) => e.path),
      ['app.js'],
    )
    const random = Buffer.alloc(64 * 1024)
    for (let i = 0; i < random.length; i++) random[i] = Math.floor(Math.random() * 256)
    writeFileSync(join(dir, 'random.bin'), random)
    const tight = { dir: 32 * 1024, tar: 16 * 1024, raw: 2 ** 20 }
    const asDir = await archiveWorkspace(hostBox(dir), signal, false, tight)
    assert.equal(asDir.entries, null)
    assert.equal(asDir.taken.skipped?.cause, 'size')
    assert.match(
      asDir.taken.skipped?.message ?? '',
      /^the workspace is \d+(\.\d+)? KB without node_modules\/, over the 32\.0 KB cap \(compressed, the cap is 16\.0 KB\)$/,
    )
    const compressed = await archiveWorkspace(hostBox(dir), signal, true, tight)
    assert.match(
      compressed.taken.skipped?.message ?? '',
      /^the workspace is \d+(\.\d+)? KB compressed without node_modules\/, over the 16\.0 KB cap$/,
    )
    const raw = await archiveWorkspace(hostBox(dir), signal, true, { ...tight, raw: 32 * 1024 })
    assert.match(
      raw.taken.skipped?.message ?? '',
      /^the workspace is .+ without node_modules\/, over the 32\.0 KB cap$/,
    )
  })

  test('a sandbox without tar takes none, saying so', async () => {
    const dir = tempDir('archive-no-tar')
    writeFileSync(join(dir, 'app.js'), 'x\n')
    const r = await archiveWorkspace(
      hostBox(dir, { PATH: '/nonexistent' }),
      new AbortController().signal,
      false,
    )
    assert.deepEqual(r.taken.skipped, {
      cause: 'error',
      message: "couldn't archive the workspace: the sandbox has no tar",
    })
  })

  test('takeSnapshot writes a directory, or a tar.gz when compressed, and records each', async () => {
    const dir = tempDir('snapshot-forms')
    const work = join(dir, 'work')
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, 'src/app.js'), 'export {}\n')
    writeFileSync(join(work, '.env'), `GITHUB_TOKEN=${SECRET}\n`)
    const signal = new AbortController().signal
    const plain = attemptFor(dir, signal)
    await takeSnapshot(plain, hostBox(work), 'final', 'teardown', LIMITS)
    const [taken] = plain.record.snapshots ?? []
    assert.deepEqual(
      { ...taken, bytes: 0 },
      {
        name: 'final',
        form: 'dir',
        path: null,
        bytes: 0,
        files: 2,
        excluded: [],
        masked: ['.env'],
        dropped: [],
        skipped: null,
      },
    )
    assert.equal(taken?.bytes, 10 + readFileSync(join(dir, 'staged/final/.env')).length)
    assert.equal(readFileSync(join(dir, 'staged/final/src/app.js'), 'utf8'), 'export {}\n')
    assert.ok(!readFileSync(join(dir, 'staged/final/.env'), 'utf8').includes(SECRET))

    const packed = attemptFor(dir, signal, true)
    await takeSnapshot(packed, hostBox(work), 'turn-1', 'harness', LIMITS)
    const [tarred] = packed.record.snapshots ?? []
    assert.equal(tarred?.form, 'tar.gz')
    const archive = readFileSync(join(dir, 'staged/turn-1.tar.gz'))
    assert.equal(tarred?.bytes, archive.length)
    assert.deepEqual(
      readTar(gunzipSync(archive))
        .filter((e) => e.type === 'file')
        .map((e) => e.path)
        .sort(),
      ['.env', 'src/app.js'],
    )
  })

  test('a snapshot that outlasts its time is recorded; a stopped attempt records nothing', async () => {
    const dir = tempDir('archive-slow')
    const slow = {
      workdir: dir,
      execOwn: (_: string, { signal }: { signal?: AbortSignal } = {}) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    } as unknown as Sandbox
    // AbortSignal.timeout doesn't hold the event loop open.
    const hold = setInterval(() => {}, 1000)
    const late = attemptFor(dir, new AbortController().signal)
    await takeSnapshot(late, slow, 'final', 'teardown', LIMITS, 50)
    clearInterval(hold)
    assert.equal(
      late.record.snapshots?.[0]?.skipped?.message,
      "couldn't archive the workspace: it took over 0s",
    )
    const stop = new AbortController()
    const stopped = attemptFor(dir, stop.signal)
    const taking = takeSnapshot(stopped, slow, 'final', 'teardown', LIMITS, 60_000)
    stop.abort()
    await taking
    assert.equal(stopped.record.snapshots, undefined)
  })

  test("the archive's transfer shows in a trace as a byte count", () => {
    assert.equal(streamPreview('--opaque-output--\nH4sIAAAA'), '<26 bytes>')
    assert.equal(streamPreview('plain output\n'), 'plain output\n')
  })
})

test("snapshot isn't in the eval's fingerprint, so changing it keeps runs comparable", () => {
  assert.equal(optionsHash([{ snapshot: false }]), optionsHash([{}]))
  assert.equal(optionsHash([{ snapshot: { when: 'turns', compress: true } }]), optionsHash([{}]))
})

const WRITES = `{ files: {
  'app/index.js': 'export const answer = 42\\n',
  'app/data.json': '{"ok":true}\\n',
  'node_modules/dep/index.js': 'module.exports = 1\\n',
  '.env': 'GITHUB_TOKEN=${SECRET}\\n',
} }`

const evalFile = (options = '{}', expected = '42') => `import { evaluate, expect } from 'reeval'
evaluate('builds the app', ${options}, async (c) => {
  await c.send('build it')
  await c.send('and check it')
  expect(await c.readFile('app/index.js'), 'wrote the app').toContain('${expected}')
})
`

const snapshotsOf = (a: AttemptRecord | undefined) =>
  (a?.snapshots ?? []).map((s) => `${s.name} ${s.form} ${s.path?.split('/').slice(-2).join('/')}`)

describe('snapshots through the CLI', () => {
  test('every attempt has its final workspace in its run directory, never in the history', async () => {
    const p = await project('snapshots-default', {
      'reeval.config.ts': fakeConfig({ harness: WRITES }),
      'evals/app.eval.ts': evalFile('{ runs: 2 }'),
    })
    const run = await runCli(p.dir, ['run', '--record'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const { run: record } = readRun(p.dir)
    const attempts = record.evals[0]?.attempts ?? []
    assert.equal(attempts.length, 2)
    for (const a of attempts) {
      assert.deepEqual(snapshotsOf(a), ['final dir snapshots/final'])
      const [final] = a.snapshots ?? []
      assert.equal(final?.files, 3)
      assert.deepEqual(final?.excluded, ['node_modules/'])
      assert.deepEqual(final?.masked, ['.env'])
      const at = join(p.dir, '.reeval/runs', record.runId, final?.path ?? '')
      assert.equal(readFileSync(join(at, 'app/index.js'), 'utf8'), 'export const answer = 42\n')
      assert.equal(existsSync(join(at, 'node_modules')), false)
      assert.ok(!readFileSync(join(at, '.env'), 'utf8').includes(SECRET))
    }
    const summary = readFileSync(join(p.dir, '.reeval/runs', record.runId, 'summary.md'), 'utf8')
    assert.match(
      summary,
      /- Snapshots \(in \.reeval\/runs, never recorded\): \[final\]\(\S+\/snapshots\/final\)/,
    )
    const history = join(p.dir, 'evals/.history', record.runId)
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? [e.name, ...walk(join(dir, e.name))] : [e.name],
      )
    assert.ok(existsSync(history), 'recorded')
    assert.ok(!walk(history).includes('snapshots'), 'no snapshot in the history')
  })

  test("'turns' adds one after each send, and compress writes tar.gz files", async () => {
    const p = await project('snapshots-turns', {
      'reeval.config.ts': fakeConfig({ harness: WRITES, extra: 'snapshot: { compress: true },' }),
      'evals/app.eval.ts': evalFile("{ snapshot: 'turns' }"),
    })
    const run = await runCli(p.dir, ['run'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const { run: record } = readRun(p.dir)
    const [attempt] = record.evals[0]?.attempts ?? []
    assert.deepEqual(snapshotsOf(attempt), [
      'turn-1 tar.gz snapshots/turn-1.tar.gz',
      'turn-2 tar.gz snapshots/turn-2.tar.gz',
      'final tar.gz snapshots/final.tar.gz',
    ])
    const final = attempt?.snapshots?.at(-1)
    const archive = readFileSync(join(p.dir, '.reeval/runs', record.runId, final?.path ?? ''))
    assert.equal(final?.bytes, archive.length)
    const app = readTar(gunzipSync(archive)).find((e) => e.path === 'app/index.js')
    assert.equal(app?.type === 'file' && app.data.toString(), 'export const answer = 42\n')
  })

  test("a failed attempt's result block prints its snapshot", async () => {
    const p = await project('snapshots-failed', {
      'reeval.config.ts': fakeConfig({ harness: WRITES }),
      'evals/app.eval.ts': evalFile('{}', 'something else'),
    })
    const run = await runCli(p.dir, ['run'])
    assert.equal(run.code, 1, run.stdout + run.stderr)
    const { run: record } = readRun(p.dir)
    assert.match(
      run.stdout,
      new RegExp(`snapshot +\\.reeval/runs/${record.runId}/\\S+/1/snapshots/final`),
    )
  })

  test("debug.keep prunes older runs' snapshots, and reeval clean the rest", async () => {
    const p = await project('snapshots-pruned', {
      'reeval.config.ts': fakeConfig({ harness: WRITES, extra: 'debug: { keep: 1 },' }),
      'evals/app.eval.ts': evalFile(),
    })
    assert.equal((await runCli(p.dir, ['run'])).code, 0)
    const first = readRun(p.dir).run
    const firstPath = join(
      p.dir,
      '.reeval/runs',
      first.runId,
      first.evals[0]?.attempts[0]?.snapshots?.[0]?.path ?? '',
    )
    assert.ok(existsSync(firstPath))
    assert.equal((await runCli(p.dir, ['run'])).code, 0)
    const second = readRun(p.dir).run
    const secondPath = join(
      p.dir,
      '.reeval/runs',
      second.runId,
      second.evals[0]?.attempts[0]?.snapshots?.[0]?.path ?? '',
    )
    assert.equal(existsSync(firstPath), false, 'the older run lost its snapshot')
    assert.ok(existsSync(join(p.dir, '.reeval/runs', first.runId, 'summary.md')), 'not the run')
    assert.ok(existsSync(secondPath))
    const clean = await runCli(p.dir, ['clean'])
    assert.equal(clean.code, 0, clean.stderr)
    assert.equal(existsSync(secondPath), false)
  })

  for (const [level, files] of [
    ['eval', { 'evals/app.eval.ts': evalFile('{ snapshot: false }') }],
    ['config', { 'reeval.config.ts': fakeConfig({ harness: WRITES, extra: 'snapshot: false,' }) }],
    [
      'profile',
      {
        'reeval.config.ts': fakeConfig({
          harness: WRITES,
          extra: 'profiles: { lean: { defaults: { snapshot: { when: false } } } },',
        }),
      },
    ],
  ] as const) {
    test(`snapshot off on the ${level} takes none`, async () => {
      const p = await project(`snapshots-off-${level}`, {
        'reeval.config.ts': fakeConfig({ harness: WRITES }),
        'evals/app.eval.ts': evalFile(),
        ...files,
      })
      const run = await runCli(p.dir, level === 'profile' ? ['run', '--profile', 'lean'] : ['run'])
      assert.equal(run.code, 0, run.stdout + run.stderr)
      const { run: record } = readRun(p.dir)
      assert.equal(record.evals[0]?.attempts[0]?.snapshots, undefined)
    })
  }
})
