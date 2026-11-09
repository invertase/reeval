import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readTar, type TarEntry, writeTar } from '../src/tarball.ts'

const file = (path: string): TarEntry => ({
  type: 'file',
  path,
  mode: 0o644,
  mtime: 0,
  data: Buffer.from(path),
})

test('readTar leaves out absolute and climbing paths and names them, but not the archive root', () => {
  const unsafe: string[] = []
  const entries = readTar(
    writeTar([
      { type: 'dir', path: '.', mode: 0o755, mtime: 0 },
      file('ok/a.txt'),
      file('../up.txt'),
      file('ok/../../up.txt'),
      file('/abs.txt'),
      file('back\\slash.txt'),
      file(
        `${'deep/'.repeat(30)}../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../x`,
      ),
    ]),
    unsafe,
  )
  assert.deepEqual(
    entries.map((e) => e.path),
    ['ok/a.txt'],
  )
  assert.equal(unsafe.length, 5)
  assert.ok(unsafe.includes('../up.txt') && unsafe.includes('/abs.txt'))
})
