// Kept workspaces: the tar reader and writer, what an archive leaves out and masks, the size cap,
// and through the CLI, every attempt keeping its final workspace by default, `keepWorkspace: false`
// at each level of the cascade, and `reeval workspace` writing it out.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { archiveWorkspace, cleanArchive } from '../src/attempt/keep-workspace.ts'
import type { Sandbox } from '../src/sandbox/index.ts'
import { extractTar, readTar, safeTarPath, type TarEntry, writeTar } from '../src/tarball.ts'
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
    const env = entries.find((e) => e.path === '.env')
    assert.ok(env?.type === 'file' && !env.data.toString().includes(SECRET))
  })
})

/** A sandbox on the host whose workspace is `dir`, enough for archiveWorkspace. */
const hostBox = (dir: string): Sandbox =>
  ({
    workdir: dir,
    execOwn: async (command: string) => {
      try {
        const stdout = execFileSync('sh', ['-c', command], { encoding: 'utf8', maxBuffer: 1 << 26 })
        return { exitCode: 0, stdout, stderr: '' }
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string }
        return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
      }
    },
  }) as unknown as Sandbox

describe('archiveWorkspace', {
  skip: process.platform === 'win32' && 'runs the archive commands in sh, which Windows lacks',
}, () => {
  test('keeps an archive under the cap, and none over it, naming the size', async () => {
    const dir = tempDir('archive-cap')
    mkdirSync(join(dir, 'node_modules/dep'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/dep/big.bin'), Buffer.alloc(1 << 20, 7))
    writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
    const signal = new AbortController().signal
    const small = await archiveWorkspace(hostBox(dir), signal)
    assert.equal(small.kept.skipped, null)
    assert.equal(small.kept.files, 1)
    assert.deepEqual(small.kept.excluded, ['node_modules/'])
    assert.ok(small.archive)
    assert.deepEqual(
      readTar(gunzipSync(small.archive))
        .filter((e) => e.type === 'file')
        .map((e) => e.path),
      ['app.js'],
    )
    const random = Buffer.alloc(64 * 1024)
    for (let i = 0; i < random.length; i++) random[i] = Math.floor(Math.random() * 256)
    writeFileSync(join(dir, 'random.bin'), random)
    const big = await archiveWorkspace(hostBox(dir), signal, 16 * 1024)
    assert.equal(big.archive, null)
    assert.equal(big.kept.skipped?.cause, 'size')
    assert.match(
      big.kept.skipped?.message ?? '',
      /^the workspace is \d+(\.\d+)? KB compressed without node_modules\/, over the 16\.0 KB cap$/,
    )
  })
})

const WRITES = `{ files: {
  'app/index.js': 'export const answer = 42\\n',
  'app/data.json': '{"ok":true}\\n',
  'node_modules/dep/index.js': 'module.exports = 1\\n',
  '.env': 'GITHUB_TOKEN=${SECRET}\\n',
} }`

const evalFile = (options = '{}') => `import { evaluate, expect } from 'reeval'
evaluate('builds the app', ${options}, async (c) => {
  await c.send('build it')
  expect(await c.readFile('app/index.js'), 'wrote the app').toContain('42')
})
`

describe('reeval workspace', () => {
  test('every attempt keeps its workspace; reeval workspace writes it out', async () => {
    const p = await project('kept-workspace', {
      'reeval.config.ts': fakeConfig({ harness: WRITES }),
      'evals/app.eval.ts': evalFile('{ runs: 2 }'),
    })
    const run = await runCli(p.dir, ['run'])
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const record = readRun(p.dir).run
    const attempts = record.evals[0]?.attempts ?? []
    assert.equal(attempts.length, 2)
    for (const a of attempts) {
      assert.equal(a.keptWorkspace?.skipped, null, JSON.stringify(a.keptWorkspace))
      assert.equal(a.keptWorkspace?.files, 3)
      assert.deepEqual(a.keptWorkspace?.excluded, ['node_modules/'])
      assert.deepEqual(a.keptWorkspace?.masked, ['.env'])
    }

    const ambiguous = await runCli(p.dir, ['workspace'])
    assert.equal(ambiguous.code, 2)
    assert.match(ambiguous.stderr, /has 2 attempts; name one/)

    const out = join(p.dir, 'out')
    const wrote = await runCli(p.dir, ['workspace', 'builds#2', out])
    assert.equal(wrote.code, 0, wrote.stdout + wrote.stderr)
    assert.match(
      wrote.stdout,
      /^wrote the final workspace of evals\/app\.eval\.ts › builds the app \[fake\/fake\/fake#2\]/,
    )
    assert.match(wrote.stdout, /3 files, \d+ B compressed/)
    assert.match(wrote.stdout, /left out: node_modules\//)
    assert.match(wrote.stdout, /secret-looking values masked in: \.env/)
    assert.equal(readFileSync(join(out, 'app/index.js'), 'utf8'), 'export const answer = 42\n')
    assert.equal(existsSync(join(out, 'node_modules')), false)
    assert.ok(!readFileSync(join(out, '.env'), 'utf8').includes(SECRET))

    const again = await runCli(p.dir, ['workspace', 'builds#2', out])
    assert.equal(again.code, 2)
    assert.match(again.stderr, /already exists and isn't empty/)

    const byDefault = await runCli(p.dir, ['workspace', 'builds#1', '--run', 'latest'])
    assert.equal(byDefault.code, 0, byDefault.stderr)
    assert.match(byDefault.stdout, /into \.reeval\/workspaces\/\S+\/1/)

    rmSync(join(p.dir, '.reeval/debug'), { recursive: true, force: true })
    const gone = await runCli(p.dir, ['workspace', 'builds#1', join(p.dir, 'out2')])
    assert.equal(gone.code, 2)
    assert.match(gone.stderr, /is gone\. A kept workspace stays in \.reeval\/debug/)
  })

  test('with one attempt, a lone argument is the directory', async () => {
    const p = await project('kept-workspace-one', {
      'reeval.config.ts': fakeConfig({ harness: WRITES }),
      'evals/app.eval.ts': evalFile(),
    })
    assert.equal((await runCli(p.dir, ['run'])).code, 0)
    const out = join(p.dir, 'here')
    const wrote = await runCli(p.dir, ['workspace', out])
    assert.equal(wrote.code, 0, wrote.stderr)
    assert.equal(readFileSync(join(out, 'app/data.json'), 'utf8'), '{"ok":true}\n')
  })

  for (const [level, files] of [
    ['eval', { 'evals/app.eval.ts': evalFile('{ keepWorkspace: false }') }],
    [
      'config',
      {
        'reeval.config.ts': fakeConfig({ harness: WRITES, extra: 'keepWorkspace: false,' }),
      },
    ],
    [
      'profile',
      {
        'reeval.config.ts': fakeConfig({
          harness: WRITES,
          extra: 'profiles: { lean: { defaults: { keepWorkspace: false } } },',
        }),
      },
    ],
  ] as const) {
    test(`keepWorkspace: false on the ${level} keeps none`, async () => {
      const p = await project(`kept-workspace-off-${level}`, {
        'reeval.config.ts': fakeConfig({ harness: WRITES }),
        'evals/app.eval.ts': evalFile(),
        ...files,
      })
      const run = await runCli(p.dir, level === 'profile' ? ['run', '--profile', 'lean'] : ['run'])
      assert.equal(run.code, 0, run.stdout + run.stderr)
      const [attempt] = readRun(p.dir).run.evals[0]?.attempts ?? []
      assert.equal(attempt?.keptWorkspace, undefined)
      const none = await runCli(p.dir, ['workspace'])
      assert.equal(none.code, 2)
      assert.match(none.stderr, /kept no workspace for .*: keepWorkspace was false/)
    })
  }
})
