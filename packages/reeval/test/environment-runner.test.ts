// runnerOf: a sandbox's harness session as the Runner the @reeval/agents driver takes, on a fake
// session that records what reaches it, and on a real Docker container next to the session itself.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, test } from 'node:test'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import { runnerSession } from '@reeval/agents'
import { createDockerSession, DEFAULT_IMAGE } from '@reeval/sandbox-docker'
import { shellQuote } from '@reeval/sandbox-docker/process'
import { runnerOf } from '../src/environment/runner.ts'
import type { NetworkSandbox } from '../src/sandbox/types.ts'

type Spawn = {
  command: string
  workingDirectory?: string
  env?: Record<string, string>
  abortSignal?: AbortSignal
  stdin?: boolean
}

const bytes = (text: string) => new TextEncoder().encode(text)
const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      if (text) c.enqueue(bytes(text))
      c.close()
    },
  })
async function text(stream: ReadableStream<Uint8Array>) {
  let out = ''
  const decoder = new TextDecoder()
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true })
  return out + decoder.decode()
}

/** A harness session that answers `uname` and records every spawn, write and network call. */
function fakeSession(uname = 'Linux\nx86_64\n') {
  const spawns: Spawn[] = []
  const files = new Map<string, Uint8Array>()
  const stdin: string[] = []
  const calls: string[] = []
  const session = {
    id: 'box-1',
    description: 'a fake box',
    defaultWorkingDirectory: '/box',
    ports: [4000],
    async spawn(o: Spawn) {
      spawns.push(o)
      if (o.command === 'refuse') throw new Error('no such sandbox')
      return {
        stdout: streamOf(o.command.startsWith('uname') ? uname : `ran ${o.command}`),
        stderr: streamOf(''),
        wait: async () => ({ exitCode: o.command === 'exit 3' ? 3 : 0 }),
        kill: async () => void calls.push(`kill ${o.command}`),
        ...(o.stdin && {
          stdin: new WritableStream<Uint8Array>({
            write: (chunk) => void stdin.push(new TextDecoder().decode(chunk)),
            close: () => void stdin.push('<eof>'),
          }),
        }),
      }
    },
    async run(o: Spawn) {
      const proc = await session.spawn(o)
      return {
        exitCode: (await proc.wait()).exitCode,
        stdout: await text(proc.stdout),
        stderr: '',
      }
    },
    readBinaryFile: async ({ path }: { path: string }) => files.get(path) ?? null,
    writeBinaryFile: async ({ path, content }: { path: string; content: Uint8Array }) =>
      void files.set(path, content),
    getPortEndpoint: async ({ port }: { port: number }) => ({ url: `ws://127.0.0.1:5${port}` }),
    async setNetworkPolicy(this: unknown) {
      calls.push(this === session ? 'policy on the session' : 'policy elsewhere')
    },
    async addRequestTransformations() {
      calls.push('add')
    },
  }
  const sandbox = {
    home: '/home/box',
    network: session as unknown as HarnessV1NetworkSandboxSession,
  } as NetworkSandbox
  return { sandbox, spawns, files, stdin, calls }
}

describe('runnerOf on a harness session', () => {
  test("names the session's id, description and ports for the session over it", () => {
    const { session } = runnerOf(fakeSession().sandbox)
    assert.deepEqual(session, { id: 'box-1', description: 'a fake box', ports: [4000] })
  })

  test('info is the platform uname names, the home and the working directory, read once', async () => {
    const { sandbox, spawns } = fakeSession('Linux\naarch64\n')
    const { runner } = runnerOf(sandbox)
    const info = await runner.info()
    assert.deepEqual(info, {
      platform: 'linux-arm64',
      home: '/home/box',
      cwd: '/box',
      shell: '/bin/sh',
    })
    await runner.info()
    assert.equal(spawns.length, 1)
    await assert.rejects(runnerOf(fakeSession('Plan9\nmips\n').sandbox).runner.info(), /Plan9/)
  })

  test('a spawn passes its command, cwd, env, signal and stdin to the session', async () => {
    const { sandbox, spawns, stdin } = fakeSession()
    const { runner } = runnerOf(sandbox)
    const signal = new AbortController().signal
    const argv = ['printf', "it's %s", 'a b']
    const command = argv.map(shellQuote).join(' ')
    const proc = runner.spawn(argv, {
      cwd: '/box/w',
      env: { A: '1' },
      signal,
      stdin: 'pipe',
    })
    await proc.write('hi')
    await proc.end()
    assert.equal(await text(proc.stdout), `ran ${command}`)
    assert.deepEqual(await proc.exited, { code: 0, signal: null })
    assert.deepEqual(stdin, ['hi', '<eof>'])
    assert.deepEqual(spawns[0], {
      command,
      workingDirectory: '/box/w',
      env: { A: '1' },
      abortSignal: signal,
      stdin: true,
    })
    const plain = runner.spawn('exit 3')
    assert.deepEqual(await plain.exited, { code: 3, signal: null })
    assert.deepEqual(spawns[1], { command: 'exit 3' })
    await assert.rejects(plain.write('x'), /wasn't spawned with stdin: 'pipe'/)
  })

  test('a spawn the session refuses fails its exit and output, and a kill of it is a no-op', async () => {
    const { runner } = runnerOf(fakeSession().sandbox)
    const proc = runner.spawn('refuse')
    await assert.rejects(proc.exited, /no such sandbox/)
    await assert.rejects(text(proc.stdout), /no such sandbox/)
    await proc.kill()
  })

  test('files go through the session as bytes, and a mode through chmod', async () => {
    const { sandbox, files, spawns } = fakeSession()
    const { runner } = runnerOf(sandbox)
    await runner.writeFile('/box/a.txt', 'é')
    assert.deepEqual(files.get('/box/a.txt'), bytes('é'))
    assert.deepEqual(await runner.readFile('/box/a.txt'), bytes('é'))
    assert.equal(await runner.readFile('/box/none'), null)
    await runner.writeFile('/box/run.sh', 'echo', { mode: 0o755 })
    assert.equal(spawns.at(-1)?.command, "chmod 755 '/box/run.sh'")
  })

  test("a forwarded port is the host and port of the session's endpoint for it", async () => {
    const { runner } = runnerOf(fakeSession().sandbox)
    const forward = await runner.forwardPort?.(4000)
    assert.equal(forward?.host, '127.0.0.1')
    assert.equal(forward?.port, 54000)
  })

  test("the session's network methods pass through, called on the session", async () => {
    const { sandbox, calls } = fakeSession()
    const { runner } = runnerOf(sandbox)
    assert.deepEqual(Object.keys(runner.network ?? {}).sort(), [
      'addRequestTransformations',
      'setNetworkPolicy',
    ])
    await runner.network?.setNetworkPolicy?.({ mode: 'deny-all' } as never)
    assert.deepEqual(calls, ['policy on the session'])
  })

  test('the session the driver builds over it reaches the same box', async () => {
    const { sandbox } = fakeSession()
    const { runner, session } = runnerOf(sandbox)
    const over = await runnerSession(runner, session)
    assert.equal(over.id, 'box-1')
    assert.equal(over.description, 'a fake box')
    assert.equal(over.defaultWorkingDirectory, '/box')
    assert.deepEqual(over.ports, [4000])
    assert.deepEqual(await over.getPortEndpoint({ port: 4000, protocol: 'ws' }), {
      url: 'ws://127.0.0.1:54000',
    })
    await over.writeTextFile({ path: 'w/b.txt', content: 'b' })
    assert.equal(await over.readTextFile({ path: '/box/w/b.txt' }), 'b')
    assert.equal('addRequestTransformations' in over, true)
    assert.equal('setRequestTransformations' in over, false)
  })
})

const dockerReady = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const skip =
  !dockerReady &&
  process.env.REEVAL_TEST_REQUIRE_DOCKER !== '1' &&
  `needs Docker and ${DEFAULT_IMAGE}`

describe('runnerOf on a Docker container', { skip, timeout: 120_000 }, () => {
  let docker: Awaited<ReturnType<typeof createDockerSession>>
  let over: HarnessV1NetworkSandboxSession
  before(async () => {
    docker = await createDockerSession({ image: DEFAULT_IMAGE })
    const { runner, session } = runnerOf({ home: '/home/reeval', network: docker } as never)
    over = await runnerSession(runner, session)
  })
  after(() => docker?.destroy())

  test('the session over it says what the container session says', () => {
    assert.equal(over.id, docker.id)
    assert.equal(over.description, docker.description)
    assert.equal(over.defaultWorkingDirectory, docker.defaultWorkingDirectory)
    assert.deepEqual(over.ports, docker.ports)
  })

  test('commands, files and paths come out as the container session gives them', async () => {
    const command = 'cd workspace 2>/dev/null; pwd; id -un; printf "%s" "$A"'
    const env = { A: 'x y' }
    assert.deepEqual(await over.run({ command, env }), await docker.run({ command, env }))
    assert.deepEqual(await over.run({ command: 'exit 7' }), await docker.run({ command: 'exit 7' }))
    await over.writeTextFile({ path: 'workspace/r.txt', content: 'é\n' })
    assert.equal(await docker.readTextFile({ path: 'workspace/r.txt' }), 'é\n')
    assert.deepEqual(
      await over.stat({ path: 'workspace/r.txt' }),
      await docker.stat({ path: 'workspace/r.txt' }),
    )
    assert.deepEqual(
      await over.listDirectory({ path: 'workspace' }),
      await docker.listDirectory({ path: 'workspace' }),
    )
    assert.equal(await over.readBinaryFile({ path: 'workspace/none' }), null)
  })

  test("a port the container listens on is reached through the session's endpoint", async () => {
    const [port] = docker.ports
    assert.ok(port)
    const server = await over.spawn({
      command: `node -e "require('http').createServer((q, s) => s.end('up')).listen(${port})"`,
    })
    try {
      const { url } = await over.getPortEndpoint({ port, protocol: 'http' })
      let said = ''
      for (let i = 0; i < 50 && !said; i++) {
        said = await fetch(url).then(
          (r) => r.text(),
          () => '',
        )
        if (!said) await new Promise((r) => setTimeout(r, 100))
      }
      assert.equal(said, 'up')
    } finally {
      await server.kill()
    }
  })
})
