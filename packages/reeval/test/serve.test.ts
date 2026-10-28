import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import {
  awaitListening,
  decide,
  type Listener,
  parseProbe,
  probeScript,
  procAddress,
  SETTLE_MS,
  type ServeProbe,
} from '../src/attempt/serve.ts'

const linux = process.platform === 'linux' ? false : 'reads /proc'

test('procAddress reads /proc/net/tcp and tcp6 addresses', () => {
  assert.equal(procAddress('0100007F'), '127.0.0.1')
  assert.equal(procAddress('00000000'), '0.0.0.0')
  assert.equal(procAddress('020011AC'), '172.17.0.2')
  assert.equal(procAddress('00000000000000000000000001000000'), '::1')
  assert.equal(procAddress('00000000000000000000000000000000'), '::')
  assert.equal(procAddress('0000000000000000FFFF00000100007F'), '127.0.0.1')
  assert.equal(procAddress('000080FE00000000FF005450B6AD1DFE'), 'fe80::5054:ff:fe1d:adb6')
})

test('parseProbe keeps reachable listeners, marking the ones the tree holds', () => {
  const probe = parseProbe(
    [
      'tree 10 11',
      "lrwx------ 1 u u 64 Oct 28 10:00 3 -> 'socket:[100]'",
      'lrwx------ 1 u u 64 Oct 28 10:00 4 -> socket:[101]',
      'lrwx------ 1 u u 64 Oct 28 10:00 5 -> socket:[102]',
      'lr-x------ 1 u u 64 Oct 28 10:00 6 -> /dev/null',
      'listen 0100007F:1435 100',
      'listen 00000000000000000000000001000000:1435 101',
      'listen 020011AC:0050 102',
      'listen 00000000:0016 999',
    ].join('\n'),
  )
  assert.deepEqual(probe, {
    proc: true,
    alive: true,
    listeners: [
      { port: 5173, address: '127.0.0.1', inode: '100', own: true },
      { port: 5173, address: '::1', inode: '101', own: true },
      { port: 22, address: '0.0.0.0', inode: '999', own: false },
    ],
  })
  assert.deepEqual(parseProbe('tree\nlisten 0100007F:1435 100'), {
    proc: true,
    alive: false,
    listeners: [{ port: 5173, address: '127.0.0.1', inode: '100', own: false }],
  })
  assert.deepEqual(parseProbe('noproc 1\n'), { proc: false, alive: true })
})

const on = (...ports: Array<[number, string]>): Listener[] =>
  ports.map(([port, address], i) => ({ port, address, inode: String(i), own: true }))
const state = (listeners: Listener[], more: Partial<Parameters<typeof decide>[0]> = {}) => ({
  want: 4000,
  given: false,
  probe: { proc: true as const, alive: true, listeners },
  stableMs: 0,
  elapsedMs: 0,
  timeoutMs: 60_000,
  ...more,
})

test('decide takes PORT at once, and one other port only once the ports settle', () => {
  assert.deepEqual(decide(state(on([9229, '127.0.0.1'], [4000, '::'], [4000, '0.0.0.0']))), {
    kind: 'port',
    port: 4000,
    address: '0.0.0.0',
  })
  assert.deepEqual(decide(state(on([5173, '::1']))), { kind: 'wait' })
  assert.deepEqual(decide(state(on([5173, '::1']), { stableMs: SETTLE_MS })), {
    kind: 'port',
    port: 5173,
    address: '::1',
  })
  assert.deepEqual(decide(state(on([5173, '::1'], [24678, '::1']), { stableMs: SETTLE_MS })), {
    kind: 'several',
    ports: [5173, 24678],
  })
  assert.deepEqual(decide(state([], { probe: { proc: true, alive: false, listeners: [] } })), {
    kind: 'exited',
  })
  assert.deepEqual(decide(state([], { elapsedMs: 60_000 })), { kind: 'timeout', ports: [] })
})

test('decide waits only for a given port, whatever else binds first', () => {
  const side = on([6379, '127.0.0.1'])
  assert.deepEqual(decide(state(side, { given: true, stableMs: 30_000, elapsedMs: 30_000 })), {
    kind: 'wait',
  })
  assert.deepEqual(decide(state(side, { given: true, elapsedMs: 60_000 })), {
    kind: 'timeout',
    ports: [6379],
  })
  assert.deepEqual(decide(state([...side, ...on([4000, '127.0.0.1'])], { given: true })), {
    kind: 'port',
    port: 4000,
    address: '127.0.0.1',
  })
})

test('decide takes PORT from a process outside the tree, as a backgrounded server is', () => {
  const forked = { port: 4000, address: '127.0.0.1', inode: '7', own: false }
  const probe = { proc: true as const, alive: false, listeners: [forked] }
  assert.deepEqual(decide(state([], { probe })), {
    kind: 'port',
    port: 4000,
    address: '127.0.0.1',
  })
  const elsewhere = { ...forked, port: 5173 }
  assert.deepEqual(
    decide(
      state([], { probe: { ...probe, alive: true, listeners: [elsewhere] }, stableMs: SETTLE_MS }),
    ),
    { kind: 'wait' },
  )
})

test('awaitListening fails with the last output, naming the ports and the hint', async () => {
  const probes: ServeProbe[] = [
    { proc: true, alive: true, listeners: on([5173, '127.0.0.1'], [24678, '127.0.0.1']) },
  ]
  await assert.rejects(
    awaitListening('npm run dev', {
      want: 4000,
      given: false,
      probe: async () => probes[0] as ServeProbe,
      output: async () => '  VITE ready\n',
      timeoutMs: 60_000,
    }),
    {
      message:
        'c.serve("npm run dev") listens on ports 5173 and 24678, and not on PORT (4000). Pass the one it serves on: c.serve("npm run dev", 5173). Its last output:\nVITE ready',
    },
  )
  await assert.rejects(
    awaitListening('npm run dev', {
      want: 4000,
      given: false,
      probe: async () => ({ proc: true, alive: false, listeners: [] }),
      output: async () => 'sh: vite: not found',
    }),
    {
      message:
        'c.serve("npm run dev") exited before it listened on a port. Its last output:\nsh: vite: not found',
    },
  )
})

test('awaitListening names the other ports when a given port never listens', async () => {
  await assert.rejects(
    awaitListening('redis-server & npm start', {
      want: 3000,
      given: true,
      probe: async () => ({ proc: true, alive: true, listeners: on([6379, '127.0.0.1']) }),
      output: async () => '',
      timeoutMs: 300,
    }),
    {
      message:
        'c.serve("redis-server & npm start") didn\'t listen on the port passed (3000) within 0.3s; it listens on port 6379',
    },
  )
})

test('awaitListening without /proc waits for PORT on the host', async () => {
  let tries = 0
  const found = await awaitListening('npm start', {
    want: 4000,
    given: false,
    probe: async () => ({ proc: false, alive: true }),
    output: async () => '',
    hostListening: async () => (++tries > 2 ? '127.0.0.1' : undefined),
  })
  assert.equal(found.port, 4000)
  assert.equal(found.detected, false)
})

test("the probe script finds a process tree's listeners from /proc", { skip: linux }, async () => {
  const child = spawn(
    'sh',
    [
      '-c',
      `node -e "require('net').createServer().listen(0, '::1', function () { console.log(this.address().port) })"`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], detached: true },
  )
  try {
    const [line] = (await once(child.stdout, 'data')) as [Buffer]
    const port = Number(line.toString().trim())
    const out = spawnSync('sh', ['-c', probeScript(String(child.pid))], { encoding: 'utf8' })
    const probe = parseProbe(out.stdout)
    assert.ok(probe.proc && probe.alive)
    assert.deepEqual(
      probe.listeners.filter((l) => l.own).map((l) => [l.port, l.address]),
      [[port, '::1']],
    )
    const other = parseProbe(
      spawnSync('sh', ['-c', probeScript('999999999')], { encoding: 'utf8' }).stdout,
    )
    assert.deepEqual(other.proc && other.alive, false)
    assert.ok(other.proc && other.listeners.every((l) => !l.own))
    assert.equal(spawnSync('sh', ['-c', probeScript(String(child.pid))]).status, 0)
  } finally {
    process.kill(-(child.pid as number), 'SIGKILL')
  }
})
