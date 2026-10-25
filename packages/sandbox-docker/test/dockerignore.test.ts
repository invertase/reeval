// Which files `docker build` sends: each case's `sent` is what Docker 29's BuildKit copies with
// `COPY . /` (less the Dockerfile and `.dockerignore`, which reeval always hashes), and the
// Docker test below checks every case against a real build.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { dockerfileTag } from '../src/build-image.ts'
import { contextFiles } from '../src/dockerignore.ts'
import { CLI, ENGINE, REQUIRE_ENGINE } from './engine.ts'

type Case = { name: string; ignore: string; files: string[]; sent: string[] }

const CASES: Case[] = [
  {
    name: 'a re-included file under an excluded directory',
    ignore: 'dir\n!dir/keep.txt\n',
    files: ['dir/keep.txt', 'dir/drop.txt', 'a.txt'],
    sent: ['a.txt', 'dir/keep.txt'],
  },
  {
    name: 'a re-included directory under an excluded one',
    ignore: 'dir\n!dir/sub\n',
    files: ['dir/a', 'dir/sub/b', 'dir/sub/c/d'],
    sent: ['dir/sub/b', 'dir/sub/c/d'],
  },
  {
    name: 'a globbed re-include under everything excluded',
    ignore: '*\n!**/*.md\n!Dockerfile\n!.dockerignore\n',
    files: ['a.md', 'b/c.md', 'b/c.txt', 'd'],
    sent: ['a.md', 'b/c.md'],
  },
  {
    name: 're-including a directory does not undo an earlier rule inside it',
    ignore: 'a/c\n!a\n',
    files: ['a/c', 'a/d'],
    sent: ['a/d'],
  },
  {
    name: 'a leading and a trailing slash',
    ignore: '/dist/\n**/cache\n',
    files: ['dist/a', 'src/dist/b', 'a/b/cache/c', 'cache/d'],
    sent: ['src/dist/b'],
  },
  {
    name: 'a trailing **',
    ignore: 'dir/**\n',
    files: ['dir/a', 'dir/b/c', 'dirx/y'],
    sent: ['dirx/y'],
  },
  {
    name: '** inside a segment spans whole directories only',
    ignore: 'a**b\n',
    files: ['ab', 'axb', 'ax/b'],
    sent: ['axb'],
  },
  {
    name: 'a leading ** matches any suffix',
    ignore: '**foo\n',
    files: ['xfoo', 'd/yfoo', 'foo', 'bar'],
    sent: ['bar'],
  },
  {
    name: '** with a re-include',
    ignore: '**\n!keep\n!Dockerfile\n!.dockerignore\n',
    files: ['keep', 'other', 'd/keep'],
    sent: ['keep'],
  },
  {
    name: '*/** excludes only what is in a directory',
    ignore: '*/**\n',
    files: ['a', 'b/c'],
    sent: ['a'],
  },
  {
    name: 'character classes, escapes and regexp characters',
    ignore: 'f[0-9]\ng[^a]\nh\\[i\nx.y\nk+\n',
    files: ['f1', 'fa', 'ga', 'gb', 'h[i', 'hxi', 'x.y', 'xzy', 'kk', 'k+'],
    sent: ['fa', 'ga', 'hxi', 'kk', 'xzy'],
  },
  {
    name: '? and a negated class match one character beyond the BMP',
    ignore: 'a?\n[^x]c\n',
    files: ['a😀', 'b', '😀c', 'xc'],
    sent: ['b', 'xc'],
  },
  {
    name: 'an escaped letter is a regexp escape and a lone ] is literal',
    ignore: '\\a\nb]\n',
    files: ['a', 'b]', 'c'],
    sent: ['a', 'c'],
  },
  {
    name: 'patterns are cleaned',
    ignore: 'x/../y\n./z\n',
    files: ['y', 'z', 'x/w'],
    sent: ['x/w'],
  },
  {
    name: 'a comment starts the line; an indented # is a pattern',
    ignore: '\uFEFF# a\n  # x\n',
    files: ['# a', '# x', 'y'],
    sent: ['# a', 'y'],
  },
  {
    name: 'the Dockerfile and .dockerignore are hashed even when excluded',
    ignore: 'Dockerfile\n.dockerignore\n',
    files: ['y'],
    sent: ['y'],
  },
]

const DOCKERFILE = 'FROM scratch\nCOPY . /\n'

function context(c: Case): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-dockerignore-'))
  const file = join(dir, 'Dockerfile')
  writeFileSync(file, DOCKERFILE)
  writeFileSync(join(dir, '.dockerignore'), c.ignore)
  for (const path of c.files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), `${path}\n`)
  }
  return { dir, file }
}

const listed = (sent: string[]) => [...sent, 'Dockerfile', '.dockerignore'].sort()

describe('contextFiles', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { dir, file } = context(c)
      assert.deepEqual(contextFiles(dir, file), listed(c.sent))
      rmSync(dir, { recursive: true, force: true })
    })
  }

  test('editing a re-included file changes the Dockerfile tag', () => {
    const { dir, file } = context(CASES[0] as Case)
    const first = dockerfileTag(file, 'cursor').tag
    writeFileSync(join(dir, 'dir', 'keep.txt'), 'v2\n')
    assert.notEqual(dockerfileTag(file, 'cursor').tag, first)
    writeFileSync(join(dir, 'dir', 'drop.txt'), 'v2\n')
    const edited = dockerfileTag(file, 'cursor').tag
    writeFileSync(join(dir, 'dir', 'drop.txt'), 'v3\n')
    assert.equal(dockerfileTag(file, 'cursor').tag, edited, 'an excluded file is not hashed')
    rmSync(dir, { recursive: true, force: true })
  })
})

const dockerUp = REQUIRE_ENGINE || spawnSync(CLI, ['info'], { stdio: 'ignore' }).status === 0

const files = (root: string, rel = ''): string[] =>
  readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    return entry.isDirectory() ? files(root, path) : [path]
  })

describe('what docker build sends', {
  skip:
    ENGINE !== 'docker'
      ? 'the cases are Docker BuildKit semantics'
      : process.platform !== 'linux'
        ? 'needs Linux containers'
        : !dockerUp && 'needs Docker',
}, () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { dir } = context(c)
      const out = mkdtempSync(join(tmpdir(), 'reeval-dockerignore-out-'))
      execFileSync(CLI, ['build', '-q', '--output', `type=local,dest=${out}`, dir], {
        stdio: 'ignore',
        env: { ...process.env, DOCKER_BUILDKIT: '1' },
      })
      const sent = files(out)
        .filter((path) => path !== 'Dockerfile' && path !== '.dockerignore')
        .sort()
      assert.deepEqual(sent, c.sent)
      rmSync(dir, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    })
  }
})
