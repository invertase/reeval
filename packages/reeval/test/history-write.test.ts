import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { readRecord, writeRun } from '../src/history/files.ts'
import type { RunRecord } from '../src/history/types.ts'
import { sha256 } from '../src/ids.ts'
import { testDir } from './support/fixture.ts'

const SOURCE = join(
  testDir,
  'fixtures/records/with-remarks/evals/.history/20261021T130832Z_nogit_cursor-agent_qdw4.json',
)
const base = await readRecord(SOURCE)
const runId = base.runId

const fresh = () => mkdtempSync(join(tmpdir(), 'reeval-write-run-'))
const claimPath = (dir: string) => join(dir, `.tmp-${runId}.claim`)
const withLevel = (artifacts: RunRecord['artifacts']): RunRecord => ({ ...base, artifacts })
const twenty = () =>
  new Map(Array.from({ length: 20 }, (_, k) => [`e/${k}.txt`, Buffer.from(`file ${k}`)]))
const recorded = (dir: string) =>
  JSON.parse(readFileSync(join(dir, `${runId}.json`), 'utf8')) as RunRecord
const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('.tmp-'))

/** A pid that has exited, so `kill(pid, 0)` says ESRCH. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number

describe('writeRun claims the run before touching its artifacts', () => {
  test("a writer that loses the claim leaves the holder's artifacts alone", async () => {
    const dir = fresh()
    writeFileSync(claimPath(dir), `${process.pid}\n${hostname()}\nholder\n`)
    mkdirSync(join(dir, runId, 'e'), { recursive: true })
    writeFileSync(join(dir, runId, 'e', '0.txt'), 'the holder wrote this')
    await assert.rejects(
      writeRun(dir, withLevel('none'), new Map()),
      /is being recorded by another process right now/,
    )
    assert.equal(readFileSync(join(dir, runId, 'e', '0.txt'), 'utf8'), 'the holder wrote this')
    assert.equal(existsSync(join(dir, `${runId}.json`)), false)
    assert.equal(readFileSync(claimPath(dir), 'utf8'), `${process.pid}\n${hostname()}\nholder\n`)
  })

  test('concurrent writers: one lands whole, the other is refused', async () => {
    for (let i = 0; i < 40; i++) {
      const dir = fresh()
      const results = await Promise.allSettled([
        writeRun(dir, withLevel('all'), twenty()),
        new Promise((r) => setTimeout(r, i % 4)).then(() =>
          writeRun(dir, withLevel('none'), new Map()),
        ),
      ])
      const won = results.filter((r) => r.status === 'fulfilled')
      assert.equal(won.length, 1, `try ${i}: ${results.map((r) => r.status)}`)
      const record = recorded(dir)
      if (record.artifacts === 'all') {
        assert.equal(readdirSync(join(dir, runId, 'e')).length, 20, `try ${i}`)
      } else {
        assert.equal(existsSync(join(dir, runId)), false, `try ${i}`)
      }
      assert.deepEqual(leftovers(dir), [], `try ${i}`)
    }
  })

  test('a claim a dead process left is broken', async () => {
    const dir = fresh()
    writeFileSync(claimPath(dir), `${deadPid()}\n${hostname()}\ncrashed\n`)
    mkdirSync(join(dir, runId))
    writeFileSync(join(dir, runId, 'stale.txt'), 'from the crashed write')
    const written = await writeRun(dir, withLevel('all'), twenty())
    assert.equal(written.created, true)
    assert.equal(existsSync(join(dir, runId, 'stale.txt')), false)
    assert.equal(readdirSync(join(dir, runId, 'e')).length, 20)
    assert.deepEqual(leftovers(dir), [])
  })

  test('a stale claim another writer is breaking holds', async () => {
    const dir = fresh()
    const held = `${deadPid()}\n${hostname()}\ncrashed\n`
    writeFileSync(claimPath(dir), held)
    writeFileSync(`${claimPath(dir)}.${sha256(held).slice(0, 12)}.break`, '')
    await assert.rejects(writeRun(dir, withLevel('none'), new Map()), /another process/)
    assert.equal(readFileSync(claimPath(dir), 'utf8'), held)
  })

  test('writers in separate processes racing to break a dead claim: one lands', async () => {
    const files = pathToFileURL(join(testDir, '../src/history/files.ts')).href
    const script = `
      const { readRecord, writeRun } = await import(${JSON.stringify(files)})
      const [dir, source, level] = process.argv.slice(1)
      const record = { ...(await readRecord(source)), artifacts: level }
      const artifacts = new Map(
        level !== 'none' ? Array.from({ length: 20 }, (_, k) => ['e/' + k + '.txt', Buffer.from('f')]) : [],
      )
      await writeRun(dir, record, artifacts).then(
        () => console.log('ok'),
        (error) => console.log(error.name),
      )`
    for (let i = 0; i < 3; i++) {
      const dir = fresh()
      writeFileSync(claimPath(dir), `${deadPid()}\n${hostname()}\ncrashed\n`)
      const outputs = await Promise.all(
        ['all', 'none', 'failures'].map(
          (level) =>
            new Promise<string>((resolve) => {
              let out = ''
              const child = spawn(
                process.execPath,
                [
                  '--experimental-strip-types',
                  '--no-warnings',
                  '--input-type=module',
                  '-e',
                  script,
                  dir,
                  SOURCE,
                  level,
                ],
                { stdio: ['ignore', 'pipe', 'inherit'] },
              )
              child.stdout.on('data', (d) => {
                out += d
              })
              child.on('close', () => resolve(out.trim()))
            }),
        ),
      )
      assert.equal(outputs.filter((o) => o === 'ok').length, 1, outputs.join(', '))
      assert.deepEqual(
        outputs.filter((o) => o !== 'ok' && o !== 'HistoryError'),
        [],
      )
      const record = recorded(dir)
      assert.equal(
        existsSync(join(dir, runId, 'e')) && readdirSync(join(dir, runId, 'e')).length === 20,
        record.artifacts !== 'none',
      )
      assert.deepEqual(leftovers(dir), [])
    }
  })

  test("another host's claim holds: its process can't be probed", async () => {
    const dir = fresh()
    writeFileSync(claimPath(dir), `${deadPid()}\nnot-${hostname()}\nremote\n`)
    await assert.rejects(writeRun(dir, withLevel('none'), new Map()), /delete .*\.claim/)
  })

  test('an identical record is kept; a different one is refused', async () => {
    const dir = fresh()
    assert.equal((await writeRun(dir, withLevel('all'), twenty())).created, true)
    assert.equal((await writeRun(dir, withLevel('all'), twenty())).created, false)
    await assert.rejects(writeRun(dir, withLevel('none'), new Map()), /different content/)
    assert.equal(readdirSync(join(dir, runId, 'e')).length, 20)
    assert.deepEqual(leftovers(dir), [])
  })

  for (const status of ['interrupted', 'budget'] as const) {
    test(`a record whose status is ${status} is replaced by its resumed run`, async () => {
      const dir = fresh()
      await writeRun(dir, { ...withLevel('all'), status }, twenty())
      const resumed = new Map([['summary.md', Buffer.from('resumed')]])
      assert.equal((await writeRun(dir, withLevel('all'), resumed)).created, true)
      assert.equal(recorded(dir).status, base.status)
      assert.deepEqual(readdirSync(join(dir, runId)), ['summary.md'])
      assert.deepEqual(leftovers(dir), [])
    })
  }
})
