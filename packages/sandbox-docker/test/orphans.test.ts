// What a process killed outright leaves running, and removeOrphans finding it from the containers'
// owner label: the dead owner's go, a live one's, another host's and an inherited label's stay.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { after, describe, test } from 'node:test'
import { DEFAULT_IMAGE, LABEL } from '../src/image.ts'
import { ownerGone, ownerLabel, pidAlive, pidSpace, removeOrphans } from '../src/orphans.ts'
import { CLI, createSession, ENGINE, REQUIRE_ENGINE } from './engine.ts'

describe('ownerGone', () => {
  const alive = (pid: number, start?: string) => pid === 7 && (!start || start === '100')
  test("a dead process in this pid space is gone; a live one, another space's or no owner isn't", () => {
    assert.equal(ownerGone('8@here', 'here', alive), true)
    assert.equal(ownerGone('7@here', 'here', alive), false)
    assert.equal(ownerGone('7:100@here', 'here', alive), false)
    assert.equal(ownerGone('8@there', 'here', alive), false)
    assert.equal(ownerGone('', 'here', alive), false)
    assert.equal(ownerGone('<no value>', 'here', alive), false)
    assert.equal(ownerGone('0@here', 'here', alive), false)
    assert.equal(ownerGone('8@here.local', 'here', alive), false)
  })

  test('a pid another process has taken since is gone', () => {
    assert.equal(ownerGone('7:99@here', 'here', alive), true)
  })

  test('the same hostname in another pid namespace or boot is another space', () => {
    const [host, ...rest] = pidSpace().split('/')
    assert.equal(
      ownerGone(`1@${host}`, pidSpace(), () => false),
      process.platform !== 'linux',
    )
    if (process.platform === 'linux') assert.equal(rest.length, 2, pidSpace())
  })
})

describe('pidAlive', () => {
  test("this process is alive at its own start time, and isn't at another", () => {
    const [, start] = /^\d+:(\d+)@/.exec(ownerLabel()) ?? []
    assert.equal(pidAlive(process.pid, start), true)
    if (start) assert.equal(pidAlive(process.pid, `${Number(start) + 1}`), false)
    const exited = spawnSync(process.execPath, ['-e', '0']).pid as number
    assert.equal(pidAlive(exited), false)
  })
})

const dockerReady = (() => {
  try {
    execFileSync(CLI, ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const skip = !dockerReady && !REQUIRE_ENGINE && `needs ${CLI} and ${DEFAULT_IMAGE}`

const TEST_LABEL = 'ai.reeval.test'
const tag = `orphans-${process.pid}`

const cli = (args: string[]) => execFileSync(CLI, args, { encoding: 'utf8' }).trim()
const exists = (id: string) => cli(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`]) !== ''
const ownerOf = (id: string) =>
  cli(['inspect', '--format', `{{index .Config.Labels "${LABEL.owner}"}}`, id])
const runDetached = (args: string[]) =>
  cli(['run', '--detach', '--rm', '--label', `${TEST_LABEL}=${tag}`, ...args])

/** A session created by a child process that is then killed with SIGKILL: its container's id. */
async function killedOwnersContainer(): Promise<string> {
  const session = new URL('../src/session.ts', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `import { createDockerSession } from ${JSON.stringify(session)}
const s = await createDockerSession(${JSON.stringify({ image: DEFAULT_IMAGE, engine: ENGINE, labels: { [TEST_LABEL]: tag } })})
console.log(s.id)
setInterval(() => {}, 1000)`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const [line] = await createInterface({ input: child.stdout })
    [Symbol.asyncIterator]()
    .next()
    .then((r) => [r.value as string | undefined])
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
  assert.ok(line, 'the child printed its container id')
  return line.trim()
}

describe('removeOrphans', { skip, timeout: 120_000 }, () => {
  const image = `reeval-orphans-test:${process.pid}`
  after(() => {
    const left = cli(['ps', '-aq', '--filter', `label=${TEST_LABEL}=${tag}`])
    if (left) execFileSync(CLI, ['rm', '-f', ...left.split(/\s+/)], { stdio: 'ignore' })
    execFileSync(CLI, ['image', 'rm', '-f', image], { stdio: 'ignore' })
  })

  test('removes the container of a session whose process was killed, and nothing else', async () => {
    const live = await createSession({ image: DEFAULT_IMAGE, labels: { [TEST_LABEL]: tag } })
    try {
      assert.equal(ownerOf(live.id), ownerLabel())
      const dead = await killedOwnersContainer()
      // The bug this guards: nothing removes it, so it runs on until its lifetime ends.
      assert.ok(exists(dead), 'a SIGKILL leaves the container running')

      // A container of an image committed from it inherits its owner label, which names no owner.
      cli(['commit', dead, image])
      const inherited = runDetached(['--entrypoint', 'sleep', image, '300'])
      assert.equal(ownerOf(inherited), ownerOf(dead))
      const owned = (owner: string) =>
        runDetached([
          '--label',
          `${LABEL.owner}=${owner}`,
          '--entrypoint',
          'sleep',
          DEFAULT_IMAGE,
          '300',
        ])
      const elsewhere = owned(`1@elsewhere-${tag}`)
      // This pid with another start time: a process that had it before this one.
      const recycled = owned(`${process.pid}:1@${pidSpace()}`)
      const exited = spawnSync(process.execPath, ['-e', '0']).pid as number
      // Off Linux the hostname is the whole pid space, so only there is this another one.
      const sameName =
        process.platform === 'linux' ? owned(`${exited}@${pidSpace().split('/')[0]}`) : undefined

      const removed = await removeOrphans(ENGINE)
      for (const id of [dead, recycled]) {
        assert.ok(removed.includes(id), `removed ${id}`)
        assert.equal(exists(id), false)
      }
      for (const [what, id] of [
        ['a live process', live.id],
        ['an inherited label', inherited],
        ["another host's process", elsewhere],
        ...(sameName ? [['another pid namespace under this hostname', sameName] as const] : []),
      ] as const) {
        assert.ok(!removed.includes(id) && exists(id), `kept the container of ${what}`)
      }

      // Seen from that other host, whose process has exited, it is left behind.
      assert.deepEqual(
        await removeOrphans(ENGINE, { space: `elsewhere-${tag}`, alive: () => false }),
        [elsewhere],
      )
    } finally {
      await live.destroy()
    }
  })
})
