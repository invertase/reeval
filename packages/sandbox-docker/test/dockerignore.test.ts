// Which files reeval hashes for a build context: each case's `hashed` is what `contextFiles`
// returns, and the Docker test below checks every file a real `docker build` sends is in it.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { dockerfileTag } from '../src/build-image.ts'
import { contextFiles } from '../src/dockerignore.ts'
import { CLI, ENGINE, REQUIRE_ENGINE } from './engine.ts'

type Case = {
  name: string
  ignore: string
  files: string[]
  /** Every file in the context but those `docker build` leaves out, and some it sends. */
  hashed: string[]
  dockerfile?: string
}

const CASES: Case[] = [
  {
    name: 'a re-included file under an excluded directory',
    ignore: 'dir\n!dir/keep.txt\n',
    files: ['dir/keep.txt', 'dir/drop.txt', 'a.txt'],
    hashed: ['a.txt', 'dir/keep.txt'],
  },
  {
    name: 'a re-included directory under an excluded one',
    ignore: 'dir\n!dir/sub\n',
    files: ['dir/a', 'dir/sub/b', 'dir/sub/c/d'],
    hashed: ['dir/sub/b', 'dir/sub/c/d'],
  },
  {
    name: 'a globbed re-include under everything excluded',
    ignore: '*\n!**/*.md\n!Dockerfile\n!.dockerignore\n',
    files: ['a.md', 'b/c.md', 'b/c.txt', 'd'],
    hashed: ['a.md', 'b/c.md'],
  },
  {
    name: 'an exclusion repeated after a re-include',
    ignore: 'q\n!q/p\nq\n',
    files: ['q/p', 'q/r'],
    hashed: ['q/p'],
  },
  {
    name: 'a re-included directory keeps what an earlier rule excluded in it',
    ignore: 'a/c\n!a\n',
    files: ['a/c', 'a/d'],
    hashed: ['a/c', 'a/d'],
  },
  {
    name: 'a leading and a trailing slash',
    ignore: '/dist/\n**/cache\n',
    files: ['dist/a', 'src/dist/b', 'a/b/cache/c', 'cache/d'],
    hashed: ['src/dist/b'],
  },
  {
    name: 'patterns match case-sensitively',
    ignore: 'Foo\n',
    files: ['foo', 'Foo'],
    hashed: ['foo'],
  },
  {
    name: 'an exclusion with escapes, classes or regexp characters is dropped',
    ignore: 'f[0-9]\nk+\n\\a\na|b\nx**\nx.y\n',
    files: ['f1', 'kk', 'a', 'b', 'xz', 'x.y'],
    hashed: ['a', 'b', 'f1', 'kk', 'xz'],
  },
  {
    name: 'a re-include with escapes, classes or regexp characters keeps everything',
    ignore: '*\n!**k\n',
    files: ['xk', 'y'],
    hashed: ['xk', 'y'],
  },
  {
    name: 'a re-include starting # keeps everything',
    ignore: '*\n!#k\n',
    files: ['#k', 'y'],
    hashed: ['#k', 'y'],
  },
  {
    name: 'a name beyond the BMP is always hashed',
    ignore: 'a??\n*c\n',
    files: ['a😀', 'ab', '😀c', 'xc'],
    hashed: ['a😀', 'ab', '😀c'],
  },
  {
    name: 'a comment starts the line; an indented # is a pattern',
    ignore: '\uFEFF# a\n  # x\n',
    files: ['# a', '# x', 'y'],
    hashed: ['# a', 'y'],
  },
  {
    name: 'the Dockerfile and .dockerignore are hashed even when excluded',
    ignore: 'Dockerfile\n.dockerignore\n',
    files: ['y'],
    hashed: ['y'],
  },
  {
    name: 'a Dockerfile in an excluded directory is hashed',
    ignore: 'build\n',
    files: ['build/other', 'y'],
    hashed: ['y'],
    dockerfile: 'build/Dockerfile',
  },
]

const DOCKERFILE = 'FROM scratch\nCOPY . /\n'

function context(c: Case): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-dockerignore-'))
  const file = join(dir, c.dockerfile ?? 'Dockerfile')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, DOCKERFILE)
  writeFileSync(join(dir, '.dockerignore'), c.ignore)
  for (const path of c.files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), `${path}\n`)
  }
  return { dir, file }
}

const listed = (c: Case) => [...c.hashed, c.dockerfile ?? 'Dockerfile', '.dockerignore'].sort()

describe('contextFiles', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { dir, file } = context(c)
      assert.deepEqual(contextFiles(dir, file), listed(c))
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

describe('what docker build sends is hashed', {
  skip:
    ENGINE !== 'docker'
      ? 'the cases are Docker BuildKit semantics'
      : process.platform !== 'linux'
        ? 'needs Linux containers'
        : !dockerUp && 'needs Docker',
}, () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { dir, file } = context(c)
      const out = mkdtempSync(join(tmpdir(), 'reeval-dockerignore-out-'))
      execFileSync(CLI, ['build', '-q', '-f', file, '--output', `type=local,dest=${out}`, dir], {
        stdio: 'ignore',
        env: { ...process.env, DOCKER_BUILDKIT: '1' },
      })
      const hashed = new Set(contextFiles(dir, file))
      assert.deepEqual(
        files(out).filter((path) => !hashed.has(path)),
        [],
        'docker build sent files the tag does not hash',
      )
      rmSync(dir, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    })
  }
})
