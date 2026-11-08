// History archives: the zip writer and reader (src/archive/zip.ts), checked against each other
// and against Info-ZIP's unzip and Python's zipfile, and the run archive with its manifest
// (src/archive/index.ts).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { crc32 } from 'node:zlib'
import { ArchiveError, MANIFEST_FILE, openArchive, writeArchive } from '../src/archive/index.ts'
import type { ArchiveManifest } from '../src/archive/types.ts'
import {
  bufferSource,
  crc32Of,
  fileSource,
  readZip,
  safeZipPath,
  ZipError,
  type ZipMethod,
  ZipWriter,
} from '../src/archive/zip.ts'
import { sha256 } from '../src/ids.ts'
import { NewerSchemaError } from '../src/view/record.ts'
import { corpus } from './support/corpus.ts'

const dir = mkdtempSync(join(tmpdir(), 'reeval-archive-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const RUN = '20260924T152700Z_009763c_elliot-hesp_k3f9'
const MTIME = new Date(Date.UTC(2026, 8, 24, 15, 27, 0))

type Entry = { path: string; data: Uint8Array; method?: ZipMethod }

async function zip(entries: Entry[], zip64: 'auto' | 'always' = 'auto'): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  const writer = new ZipWriter((b) => void chunks.push(Buffer.from(b)), { mtime: MTIME, zip64 })
  for (const e of entries) await writer.add(e.path, e.data, e.method)
  const size = await writer.finish()
  const out = Buffer.concat(chunks)
  assert.equal(out.length, size)
  return out
}

async function unzipped(bytes: Uint8Array): Promise<Record<string, string>> {
  const reader = await readZip(bufferSource(bytes))
  const out: Record<string, string> = {}
  for (const e of reader.entries) out[e.path] = (await reader.read(e)).toString('utf8')
  return out
}

const tool = (name: string, args: string[]) => {
  const r = spawnSync(name, args, { encoding: 'utf8' })
  return r.error ? null : r
}
const hasUnzip = tool('unzip', ['-v']) !== null
const hasPython = tool('python3', ['-c', 'import zipfile'])?.status === 0

const python = (script: string, ...args: string[]) => {
  const r = spawnSync('python3', ['-c', script, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

const ENTRIES: Entry[] = [
  { path: 'a.txt', data: Buffer.from('hello\n'.repeat(200)) },
  { path: 'empty.txt', data: Buffer.alloc(0) },
  { path: 'dir/ünïcode ☃.json', data: Buffer.from('{"snow":"man"}\n'.repeat(10)) },
  { path: 'noise.bin', data: randomBytes(4096) },
  { path: 'kept.txt', data: Buffer.from('stored as asked\n'.repeat(20)), method: 'store' },
]
const expected = Object.fromEntries(ENTRIES.map((e) => [e.path, Buffer.from(e.data).toString()]))

describe('zip writer and reader', () => {
  test('a zip it writes reads back, deflating what shrinks and storing the rest', async () => {
    const bytes = await zip(ENTRIES)
    const reader = await readZip(bufferSource(bytes))
    assert.deepEqual(
      reader.entries.map((e) => [e.path, e.method]),
      [
        ['a.txt', 'deflate'],
        ['empty.txt', 'store'],
        ['dir/ünïcode ☃.json', 'deflate'],
        ['noise.bin', 'store'],
        ['kept.txt', 'store'],
      ],
    )
    assert.deepEqual(await unzipped(bytes), expected)
    assert.ok((reader.get('a.txt')?.compressedSize ?? 0) < 100)
  })

  test('the same entries and time give the same bytes', async () => {
    assert.deepEqual(await zip(ENTRIES), await zip(ENTRIES))
    assert.deepEqual(await zip(ENTRIES, 'always'), await zip(ENTRIES, 'always'))
    assert.notDeepEqual(await zip(ENTRIES), await zip(ENTRIES, 'always'))
  })

  test('zip64 records on every entry read back', async () => {
    const bytes = await zip(ENTRIES, 'always')
    assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'a zip64 end record')
    assert.deepEqual(await unzipped(bytes), expected)
  })

  test('from 65,535 entries the count goes in a zip64 end record', async () => {
    const entries = Array.from({ length: 65_535 }, (_, i) => ({
      path: `f/${i}`,
      data: Buffer.alloc(0),
      method: 'store' as const,
    }))
    const bytes = await zip(entries)
    assert.ok(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'a zip64 end record')
    const reader = await readZip(bufferSource(bytes))
    assert.equal(reader.entries.length, 65_535)
    assert.equal(reader.entries.at(-1)?.path, 'f/65534')
    const fewer = await zip(entries.slice(0, 65_534))
    assert.ok(!fewer.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'no zip64 below 65,535')
    assert.equal((await readZip(bufferSource(fewer))).entries.length, 65_534)
  })

  test('the CRC-32 of a buffer read in pieces is the CRC-32 of the whole', () => {
    const data = randomBytes(10_000)
    assert.equal(crc32Of(data, 1024), crc32(data))
    assert.equal(crc32Of(data, 3), crc32(data))
    assert.equal(crc32Of(Buffer.alloc(0)), 0)
  })

  test('every timestamp is the one given, in MS-DOS form', async () => {
    const reader = await readZip(bufferSource(await zip(ENTRIES)))
    const bytes = await zip(ENTRIES)
    const at = reader.entries[0]?.offset ?? 0
    const time = bytes.readUInt16LE(at + 10)
    const date = bytes.readUInt16LE(at + 12)
    assert.deepEqual(
      [
        (date >> 9) + 1980,
        (date >> 5) & 15,
        date & 31,
        time >> 11,
        (time >> 5) & 63,
        (time & 31) * 2,
      ],
      [2026, 9, 24, 15, 27, 0],
    )
  })

  test('Info-ZIP unzip tests and lists what it writes, zip64 included', {
    skip: !hasUnzip && 'unzip is not installed',
  }, async () => {
    for (const mode of ['auto', 'always'] as const) {
      const file = join(dir, `unzip-${mode}.zip`)
      writeFileSync(file, await zip(ENTRIES, mode))
      const r = spawnSync('unzip', ['-t', file], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /No errors detected/)
      const out = join(dir, `out-${mode}`)
      assert.equal(spawnSync('unzip', ['-q', file, '-d', out]).status, 0)
      assert.equal(readFileSync(join(out, 'a.txt'), 'utf8'), expected['a.txt'])
    }
  })

  test("Python's zipfile reads what it writes, names and timestamps included", {
    skip: !hasPython && 'python3 is not installed',
  }, async () => {
    for (const mode of ['auto', 'always'] as const) {
      const file = join(dir, `python-${mode}.zip`)
      writeFileSync(file, await zip(ENTRIES, mode))
      const listed = JSON.parse(
        python(
          'import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps([[i.filename,list(i.date_time),z.read(i).decode("utf8","replace") if i.filename!="noise.bin" else ""] for i in z.infolist()]))',
          file,
        ),
      )
      assert.deepEqual(
        listed.map((l: unknown[]) => l[0]),
        ENTRIES.map((e) => e.path),
      )
      assert.deepEqual(listed[0][1], [2026, 9, 24, 15, 27, 0])
      assert.equal(listed[2][2], expected['dir/ünïcode ☃.json'])
    }
  })

  test('it reads zips others write: a comment, a data descriptor, zip64 from a stream', {
    skip: !hasPython && 'python3 is not installed',
  }, async () => {
    const file = join(dir, 'python-written.zip')
    python(
      'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:\n  z.comment=b"a comment"\n  z.writestr("x/y.txt","why\\n"*50)\n  z.writestr("x/","")\n  with z.open("streamed.txt","w",force_zip64=True) as f: f.write(b"streamed\\n")',
      file,
    )
    const source = await fileSource(file)
    try {
      const reader = await readZip(source)
      assert.deepEqual(
        reader.entries.map((e) => e.path),
        ['x/y.txt', 'streamed.txt'],
        'folders are left out',
      )
      assert.equal((await reader.read(reader.entries[0] as never)).toString(), 'why\n'.repeat(50))
      assert.equal((await reader.read(reader.entries[1] as never)).toString(), 'streamed\n')
    } finally {
      await source.close()
    }
  })

  test('refuses a path that is absolute, climbs out, is a folder or is there already', async () => {
    for (const bad of ['/etc/passwd', '../up', 'a/../../up', 'C:/x', 'a\\b', 'a/', '']) {
      assert.equal(safeZipPath(bad), null, bad)
      await assert.rejects(zip([{ path: bad, data: Buffer.from('x') }]), ZipError, bad)
    }
    assert.equal(safeZipPath('a/./b'), 'a/b')
    await assert.rejects(zip([{ path: 'a/./b', data: Buffer.from('x') }]), ZipError)
    await assert.rejects(
      zip([
        { path: 'a', data: Buffer.from('x') },
        { path: 'a', data: Buffer.from('y') },
      ]),
      /a is in the zip already/,
    )
    await assert.rejects(zip([{ path: 'x'.repeat(65_536), data: Buffer.from('x') }]), /too long/)
    const writer = new ZipWriter(() => {}, { mtime: MTIME })
    await writer.finish()
    await assert.rejects(writer.add('late', Buffer.from('x')), /the zip is finished/)
    await assert.rejects(writer.finish(), /finished already/)
  })

  test('refuses to read an entry that climbs out, another method, or one stored twice', {
    skip: !hasPython && 'python3 is not installed',
  }, async () => {
    const cases: Array<[string, RegExp]> = [
      ['z.writestr("../evil","x")', /"\.\.\/evil" isn't a relative path/],
      ['z.writestr(zipfile.ZipInfo("b.txt"),"x",compress_type=zipfile.ZIP_BZIP2)', /method 12/],
      ['z.writestr("d","1")\n  z.writestr("d","2")', /d is in the zip twice/],
    ]
    for (const [i, [body, message]] of cases.entries()) {
      const file = join(dir, `bad-${i}.zip`)
      python(
        `import sys,warnings,zipfile\nwarnings.simplefilter("ignore")\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n  ${body}`,
        file,
      )
      await assert.rejects(readZip(bufferSource(readFileSync(file))), message)
    }
  })

  test('a changed byte, a cut-short zip and a wrong declared size fail with a ZipError', async () => {
    const bytes = await zip(ENTRIES)
    const reader = await readZip(bufferSource(bytes))
    const kept = reader.get('kept.txt')
    assert.ok(kept)
    const flipped = Buffer.from(bytes)
    const at = kept.offset + 30 + Buffer.byteLength('kept.txt')
    flipped[at] = (flipped[at] ?? 0) ^ 1
    const corrupt = await readZip(bufferSource(flipped))
    await assert.rejects(corrupt.read(corrupt.get('kept.txt') as never), /CRC-32/)

    await assert.rejects(readZip(bufferSource(bytes.subarray(0, bytes.length - 5))), ZipError)
    await assert.rejects(readZip(bufferSource(Buffer.from('not a zip'))), /not a zip/)

    const smaller = await readZip(bufferSource(patchCentral(bytes, 'a.txt', 24, 10, 4)))
    await assert.rejects(smaller.read(smaller.get('a.txt') as never), /doesn't inflate/)
    await assert.rejects(reader.read({ ...kept }), /isn't this zip's entry/)
  })

  test('refuses a cut-short zip64 extra field, overlapping entries and a mismatched local header', async () => {
    const one = await zip([{ path: 'a.txt', data: Buffer.from('a'.repeat(100)) }], 'always')
    await assert.rejects(
      readZip(bufferSource(patchCentral(one, 'a.txt', 30, 12, 2))),
      /extra field is cut short/,
    )

    const two = await zip([
      { path: 'a.txt', data: Buffer.from('a'.repeat(100)) },
      { path: 'b.txt', data: Buffer.from('b'.repeat(100)) },
    ])
    await assert.rejects(
      readZip(bufferSource(patchCentral(two, 'b.txt', 42, 0, 4))),
      /overlaps the next entry/,
    )

    const reader = await readZip(bufferSource(two))
    const changed = Buffer.from(two)
    changed.writeUInt16LE(0, (reader.get('b.txt')?.offset ?? 0) + 8)
    const patched = await readZip(bufferSource(changed))
    await assert.rejects(
      patched.read(patched.get('b.txt') as never),
      /local header doesn't match its central directory entry/,
    )

    const renamed = Buffer.from(two)
    renamed.write('c', (reader.get('b.txt')?.offset ?? 0) + 30)
    const misnamed = await readZip(bufferSource(renamed))
    await assert.rejects(
      misnamed.read(misnamed.get('b.txt') as never),
      /local header doesn't match/,
    )

    await assert.rejects(
      readZip(bufferSource(patchCentral(two, 'b.txt', 20, 200, 4))),
      /overlaps the next entry or the central directory/,
    )

    const stored = await zip([
      { path: 's.txt', data: Buffer.from('s'.repeat(50)), method: 'store' },
    ])
    const resized = await readZip(bufferSource(patchCentral(stored, 's.txt', 24, 10, 4)))
    await assert.rejects(
      resized.read(resized.get('s.txt') as never),
      /stored as 50 bytes, not the 10/,
    )
  })

  test("reads a name that isn't UTF-8 by its bytes, an empty file right before the next", async () => {
    const bytes = await zip([
      { path: 'ab.txt', data: Buffer.alloc(0) },
      { path: 'next.txt', data: Buffer.from('n') },
    ])
    const patched = Buffer.from(bytes)
    for (let i = patched.indexOf('ab.txt'); i >= 0; i = patched.indexOf('ab.txt', i + 1)) {
      patched[i] = 0xe9
      patched[i + 1] = 0xe9
    }
    const reader = await readZip(bufferSource(patched))
    assert.deepEqual(
      reader.entries.map((e) => e.path),
      ['\ufffd\ufffd.txt', 'next.txt'],
    )
    assert.equal((await reader.read(reader.entries[0] as never)).length, 0)
    assert.equal((await reader.read(reader.entries[1] as never)).toString(), 'n')
  })

  test('reads a zip streamed with data descriptors', {
    skip: !hasPython && 'python3 is not installed',
  }, async () => {
    const out = spawnSync(
      'python3',
      [
        '-c',
        'import sys,zipfile\nclass W:\n  def __init__(s): s.b=bytearray()\n  def write(s,d): s.b+=d; return len(d)\n  def flush(s): pass\nw=W()\nwith zipfile.ZipFile(w,"w",zipfile.ZIP_DEFLATED) as z:\n  for n in ("a.txt","b/c.txt"):\n    with z.open(n,"w") as f: f.write((n*50).encode())\nsys.stdout.buffer.write(w.b)',
      ],
      { maxBuffer: 2 ** 20 },
    )
    assert.equal(out.status, 0, out.stderr?.toString())
    assert.ok(out.stdout.includes(Buffer.from([0x50, 0x4b, 0x07, 0x08])), 'has data descriptors')
    assert.deepEqual(await unzipped(out.stdout), {
      'a.txt': 'a.txt'.repeat(50),
      'b/c.txt': 'b/c.txt'.repeat(50),
    })
  })
})

/** `bytes` with the field at `at` in `path`'s central directory entry set to `value`. */
function patchCentral(bytes: Buffer, path: string, at: number, value: number, size: 2 | 4): Buffer {
  const out = Buffer.from(bytes)
  const name = Buffer.from(path)
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  for (let i = out.indexOf(signature); i >= 0; i = out.indexOf(signature, i + 4)) {
    if (!out.subarray(i + 46, i + 46 + name.length).equals(name)) continue
    if (size === 2) out.writeUInt16LE(value, i + at)
    else out.writeUInt32LE(value, i + at)
    return out
  }
  throw new Error(`no central directory entry for ${path}`)
}

const record = (extra: object = {}) =>
  Buffer.from(
    `${JSON.stringify({ kind: 'reeval-run', schemaVersion: 1, runId: RUN, evals: Array(20).fill({ key: 'e' }), ...extra }, null, 2)}\n`,
  )
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200)])

const runFiles = () => [
  { path: `${RUN}/summary.md`, data: Buffer.from('# Summary\n'.repeat(30)) },
  { path: `${RUN}.json`, data: record() },
  { path: `${RUN}/e/c/1/artifacts/shot.png`, data: PNG },
  {
    path: `${RUN}/e/c/1/transcript.jsonl`,
    data: async () => Buffer.from('{"type":"text"}\n'.repeat(20)),
  },
]

/** A zip with `manifest` as its manifest and `entries` beside it, as another writer might make. */
async function forged(manifest: object, entries: Entry[]): Promise<Buffer> {
  return zip([...entries, { path: MANIFEST_FILE, data: Buffer.from(JSON.stringify(manifest)) }])
}

describe('run archives', () => {
  test('a run archive holds the record and its files, sorted, with the manifest last', async () => {
    const file = join(dir, `${RUN}.zip`)
    const manifest = await writeArchive(file, {
      contents: 'run',
      runId: RUN,
      files: runFiles(),
      createdAt: '2026-09-24T15:40:00.000Z',
    })
    assert.deepEqual(
      manifest.files.map((f) => f.path),
      [
        `${RUN}.json`,
        `${RUN}/e/c/1/artifacts/shot.png`,
        `${RUN}/e/c/1/transcript.jsonl`,
        `${RUN}/summary.md`,
      ],
    )
    assert.equal(manifest.revision, 1)
    assert.equal(manifest.files[0]?.sha256, sha256(record()))
    assert.equal(manifest.debugLevel, undefined)
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.includes('.tmp-')),
      [],
      'no temporary file is left',
    )

    const source = await fileSource(file)
    const zipped = await readZip(source)
    assert.deepEqual(
      zipped.entries.map((e) => [e.path, e.method]),
      [
        [`${RUN}.json`, 'deflate'],
        [`${RUN}/e/c/1/artifacts/shot.png`, 'store'],
        [`${RUN}/e/c/1/transcript.jsonl`, 'deflate'],
        [`${RUN}/summary.md`, 'deflate'],
        [MANIFEST_FILE, 'deflate'],
      ],
    )
    await source.close()

    const archive = await openArchive(file)
    try {
      assert.deepEqual(archive.manifest, manifest)
      assert.ok(archive.has(`${RUN}/summary.md`))
      assert.ok(!archive.has(MANIFEST_FILE))
      assert.deepEqual(await archive.read(`${RUN}.json`), record())
      await archive.verify()
      await assert.rejects(archive.read(`${RUN}/missing`), /has no/)
    } finally {
      await archive.close()
    }
  })

  test('the same files and creation time give the same archive', async () => {
    const write = async (name: string) => {
      const file = join(dir, name)
      await writeArchive(file, {
        contents: 'run',
        runId: RUN,
        files: runFiles(),
        createdAt: '2026-09-24T15:40:00.000Z',
      })
      return readFileSync(file)
    }
    assert.deepEqual(await write('same-1.zip'), await write('same-2.zip'))
  })

  test('a debug archive holds files under the run, with its level', async () => {
    const file = join(dir, 'debug.zip')
    const manifest = await writeArchive(file, {
      contents: 'debug',
      runId: RUN,
      debugLevel: 'requests',
      revision: 2,
      files: [{ path: `${RUN}/e/c/1/requests.ndjson`, data: Buffer.from('{}\n') }],
      zip64: 'always',
    })
    assert.equal(manifest.debugLevel, 'requests')
    const archive = await openArchive(file)
    assert.equal(archive.manifest.revision, 2)
    await archive.verify()
    await archive.close()
  })

  test('refuses to write files outside the layout, without the record or with the wrong level', async () => {
    const file = join(dir, 'refused.zip')
    const write = (options: Partial<Parameters<typeof writeArchive>[1]>) =>
      writeArchive(file, { contents: 'run', runId: RUN, files: runFiles(), ...options })
    await assert.rejects(
      write({ files: [...runFiles(), { path: 'elsewhere.txt', data: Buffer.from('x') }] }),
      /elsewhere\.txt doesn't belong in a run archive/,
    )
    await assert.rejects(
      write({ files: runFiles().filter((f) => f.path !== `${RUN}.json`) }),
      /needs its record/,
    )
    await assert.rejects(
      write({ contents: 'debug', debugLevel: 'all' }),
      /\.json doesn't belong in a debug archive/,
    )
    await assert.rejects(write({ contents: 'debug' }), /needs its debug level/)
    await assert.rejects(write({ debugLevel: 'all' }), /has no debug level/)
    await assert.rejects(write({ runId: 'not-a-run' }), /isn't a run id/)
    await assert.rejects(
      write({ files: [...runFiles(), { path: `${RUN}/a//b`, data: Buffer.from('x') }] }),
      /isn't a relative path/,
    )
    await assert.rejects(
      write({ files: [...runFiles(), { path: `${RUN}/summary.md`, data: Buffer.from('2') }] }),
      /given twice/,
    )
    assert.equal(existsSync(file), false)
  })

  test('a file that fails to read leaves neither the archive nor a temporary file', async () => {
    const file = join(dir, 'failed.zip')
    const failing = {
      path: `${RUN}/zz.txt`,
      data: async (): Promise<Uint8Array> => {
        throw new Error('read failed')
      },
    }
    await assert.rejects(
      writeArchive(file, { contents: 'run', runId: RUN, files: [...runFiles(), failing] }),
      /read failed/,
    )
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.startsWith('failed.zip')),
      [],
    )
  })

  const manifestOf = (files: Entry[], extra: Partial<ArchiveManifest> = {}): ArchiveManifest => ({
    kind: 'reeval-archive',
    schemaVersion: 1,
    contents: 'run',
    runId: RUN,
    revision: 1,
    reeval: '0.0.0',
    createdAt: '2026-09-24T15:40:00.000Z',
    files: files.map((f) => ({ path: f.path, sha256: sha256(f.data), bytes: f.data.length })),
    ...extra,
  })
  const recordEntry: Entry = { path: `${RUN}.json`, data: record() }

  test('opens an archive another writer made that fits its manifest', async () => {
    const archive = await openArchive(
      bufferSource(await forged(manifestOf([recordEntry]), [recordEntry])),
    )
    await archive.verify()
    await archive.close()
  })

  test("refuses an archive whose entries aren't its manifest's files", async () => {
    const summary: Entry = { path: `${RUN}/summary.md`, data: Buffer.from('# s\n') }
    const cases: Array<[Buffer, RegExp]> = [
      [await zip([recordEntry]), /has no reeval-archive\.json/],
      [await forged({ kind: 'other' }, [recordEntry]), /isn't a reeval archive manifest/],
      [await zip([recordEntry, { path: MANIFEST_FILE, data: Buffer.from('{') }]), /doesn't read/],
      [await forged(manifestOf([recordEntry]), [recordEntry, summary]), /holds .*summary\.md/],
      [await forged(manifestOf([recordEntry, summary]), [recordEntry]), /isn't in the zip/],
      [await forged(manifestOf([summary]), [summary]), /has no record/],
      [
        await forged(manifestOf([recordEntry], { runId: 'nope' }), [recordEntry]),
        /runId must be a run id/,
      ],
      [
        await forged(manifestOf([recordEntry, { path: 'stray.txt', data: Buffer.from('x') }]), [
          recordEntry,
          { path: 'stray.txt', data: Buffer.from('x') },
        ]),
        /stray\.txt, which doesn't belong/,
      ],
      [
        await forged(
          {
            ...manifestOf([recordEntry]),
            files: [{ path: `${RUN}.json`, sha256: sha256(record()), bytes: 3 }],
          },
          [recordEntry],
        ),
        /not the 3 its manifest says/,
      ],
      [
        await zip([{ path: 'x', data: Buffer.from('y') }]).then((b) => b.subarray(5)),
        /readable zip/,
      ],
      [
        await zip([
          recordEntry,
          {
            path: MANIFEST_FILE,
            data: Buffer.from(JSON.stringify(manifestOf([recordEntry])) + ' '.repeat(65 * 2 ** 20)),
          },
        ]),
        /too large to read/,
      ],
      [
        patchCentral(
          await zip([
            recordEntry,
            { path: MANIFEST_FILE, data: Buffer.alloc(65 * 2 ** 20, 0x20), method: 'store' },
          ]),
          MANIFEST_FILE,
          24,
          10,
          4,
        ),
        /too large to read/,
      ],
    ]
    for (const [bytes, message] of cases) {
      await assert.rejects(openArchive(bufferSource(bytes), 'it'), (e: Error) => {
        assert.ok(e instanceof ArchiveError, e.message)
        assert.match(e.message, message)
        return true
      })
    }
  })

  test("a file that doesn't match its hash fails as it's read", async () => {
    const other = { ...recordEntry, data: record({ changed: true }) }
    const manifest = manifestOf([recordEntry])
    manifest.files[0] = { ...manifest.files[0], bytes: other.data.length } as never
    const archive = await openArchive(bufferSource(await forged(manifest, [other])), 'it')
    await assert.rejects(archive.read(`${RUN}.json`), /doesn't match the hash in its manifest/)
    await assert.rejects(archive.verify(), ArchiveError)
  })

  test('a field and a debug level a newer reeval added still open', async () => {
    const manifest = { ...manifestOf([recordEntry]), addedLater: { x: 1 }, debugLevel: 'more' }
    const archive = await openArchive(bufferSource(await forged(manifest, [recordEntry])), 'it')
    await archive.verify()
  })

  test('a manifest from a newer reeval throws NewerSchemaError', async () => {
    const bytes = await forged(manifestOf([recordEntry], { schemaVersion: 2 as 1 }), [recordEntry])
    await assert.rejects(
      openArchive(bufferSource(bytes), 'it'),
      (e: Error) => e instanceof NewerSchemaError && /Upgrade reeval to read it/.test(e.message),
    )
  })

  test('a missing file is an error, not an archive', async () => {
    await assert.rejects(openArchive(join(dir, 'nothing.zip')), { code: 'ENOENT' })
  })
})

describe('corpus archives', () => {
  test("each corpus archive holds its run's record and files, the saved analysis left beside it", async () => {
    const { archives } = corpus()
    assert.ok(archives.length > 0)
    for (const file of archives) {
      const history = join(file, '..')
      const archive = await openArchive(file)
      try {
        const { runId } = archive.manifest
        assert.equal(file, join(history, `${runId}.zip`))
        const loose = [`${runId}.json`, ...listUnder(join(history, runId), runId)]
        const kept = loose.filter((p) => !p.startsWith(`${runId}/analysis/`))
        assert.ok(kept.length < loose.length, 'the run has a saved analysis outside the archive')
        assert.deepEqual(
          archive.manifest.files.map((f) => f.path),
          kept.sort(),
        )
        for (const path of kept) {
          assert.deepEqual(await archive.read(path), readFileSync(join(history, path)), path)
        }
      } finally {
        await archive.close()
      }
    }
  })
})

function listUnder(root: string, at: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listUnder(join(root, e.name), `${at}/${e.name}`) : [`${at}/${e.name}`],
  )
}
