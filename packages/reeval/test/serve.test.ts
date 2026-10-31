import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import {
  awaitListening,
  decide,
  type Listener,
  parseProbe,
  printedUrls,
  probeScript,
  procAddress,
  SETTLE_MS,
  type ServeProbe,
  servePort,
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

test('parseProbe keeps the reachable LISTEN rows of /proc/net/tcp and tcp6', () => {
  const probe = parseProbe(
    [
      'alive',
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 100 1',
      '   1: 020011AC:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 102 1',
      '   2: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 103 1',
      '  sl  local_address                         remote_address                        st',
      '   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 0 0 0 0 0 101',
    ].join('\n'),
  )
  assert.deepEqual(probe, {
    proc: true,
    alive: true,
    listeners: [
      { port: 5173, address: '127.0.0.1' },
      { port: 5173, address: '::1' },
    ],
  })
  assert.deepEqual(parseProbe(''), { proc: true, alive: false, listeners: [] })
  assert.deepEqual(parseProbe('alive\nnoproc\n'), { proc: false, alive: true })
})

const on = (...ports: Array<[number, string]>): Listener[] =>
  ports.map(([port, address]) => ({ port, address }))
const state = (listeners: Listener[], more: Partial<Parameters<typeof decide>[0]> = {}) => ({
  want: 4000,
  given: false,
  probe: { proc: true as const, alive: true, listeners },
  before: new Set<number>(),
  stableMs: 0,
  elapsedMs: 0,
  timeoutMs: 60_000,
  ...more,
})

test('decide takes PORT at once, and one new port only once the ports settle', () => {
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

test('decide ignores the ports that listened before the command started', () => {
  const listeners = on([22, '0.0.0.0'], [6379, '127.0.0.1'], [5173, '::1'])
  assert.deepEqual(decide(state(listeners, { before: new Set([22, 6379]), stableMs: SETTLE_MS })), {
    kind: 'port',
    port: 5173,
    address: '::1',
  })
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

test('decide takes the one new port once the command exits, as a daemon that forked leaves it', () => {
  const probe = { proc: true as const, alive: false, listeners: on([5173, '127.0.0.1']) }
  assert.deepEqual(decide(state([], { probe })), {
    kind: 'port',
    port: 5173,
    address: '127.0.0.1',
  })
})

test('printedUrls finds the URLs on the given ports, past ANSI colors', () => {
  const vite =
    '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n' +
    '  ➜  Network: http://[::1]:5173/\n  ➜  Local:   http://localhost:5173/\n  debugger on ws://127.0.0.1:9229'
  assert.deepEqual(printedUrls(vite, [4173, 5173, 9229]), [
    { url: 'http://localhost:5173/', port: 5173 },
    { url: 'http://[::1]:5173/', port: 5173 },
  ])
  assert.deepEqual(printedUrls('http://localhost:3000', [5173]), [])
})

test('awaitListening fails with the last output, naming the ports and the hint', async () => {
  const probes: ServeProbe[] = [
    { proc: true, alive: true, listeners: on([4173, '127.0.0.1'], [5173, '127.0.0.1']) },
  ]
  const watch = { want: 4000, given: false, before: new Set<number>(), timeoutMs: 60_000 }
  await assert.rejects(
    awaitListening('npm run dev', {
      ...watch,
      probe: async () => probes[0] as ServeProbe,
      output: async () => '  ➜  Local:   http://localhost:5173/\n',
    }),
    {
      message:
        'c.serve("npm run dev") listens on ports 4173 and 5173, and not on PORT (4000). It printed http://localhost:5173/. Pass the one it serves on: c.serve("npm run dev", 5173). Its last output:\n➜  Local:   http://localhost:5173/',
    },
  )
  await assert.rejects(
    awaitListening('npm run dev', {
      ...watch,
      probe: async () => probes[0] as ServeProbe,
      output: async () => '',
    }),
    {
      message:
        'c.serve("npm run dev") listens on ports 4173 and 5173, and not on PORT (4000). Pass the one it serves on: c.serve("npm run dev", 4173)',
    },
  )
  await assert.rejects(
    awaitListening('npm run dev', {
      ...watch,
      probe: async () => ({ proc: true, alive: false, listeners: [] }),
      output: async () => 'sh: vite: not found',
    }),
    {
      message:
        'c.serve("npm run dev") exited before it listened on a port. Its last output:\nsh: vite: not found',
    },
  )
})

test('awaitListening finds a URL printed before its last lines and shows them without colors', async () => {
  const noise = Array.from({ length: 30 }, (_, i) => `\x1b[2mline ${i}\x1b[22m`).join('\n')
  await assert.rejects(
    awaitListening('npm run dev & npm run storybook', {
      want: 4000,
      given: false,
      before: new Set(),
      probe: async () => ({
        proc: true,
        alive: true,
        listeners: on([5173, '::1'], [6006, '127.0.0.1']),
      }),
      output: async () =>
        `  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n${noise}\n`,
      timeoutMs: 60_000,
    }),
    (error: Error) => {
      assert.match(
        error.message,
        /It printed http:\/\/localhost:5173\/\. Pass .*, 5173\)\. Its last output:\nline 10\n/,
      )
      assert.ok(!error.message.includes('\x1b'))
      assert.ok(!error.message.includes('line 9\n'))
      return true
    },
  )
})

test('awaitListening names the new ports when a given port never listens', async () => {
  await assert.rejects(
    awaitListening('redis-server & npm start', {
      want: 3000,
      given: true,
      before: new Set(),
      probe: async () => ({ proc: true, alive: true, listeners: on([6379, '127.0.0.1']) }),
      output: async () => '',
      timeoutMs: 300,
    }),
    {
      message:
        'c.serve("redis-server & npm start") didn\'t listen on the port passed (3000) within 0.3s; port 6379 started listening',
    },
  )
})

test('awaitListening without /proc waits for PORT on the host', async () => {
  let tries = 0
  const found = await awaitListening('npm start', {
    want: 4000,
    given: false,
    before: new Set(),
    probe: async () => ({ proc: false, alive: true }),
    output: async () => '',
    hostListening: async () => (++tries > 2 ? '127.0.0.1' : undefined),
  })
  assert.equal(found.port, 4000)
  assert.equal(found.detected, false)
})

test('servePort refuses a given port already in use and allocates PORT past one', async () => {
  const inUse = new Set([3000, 4001])
  const taken = async (port: number) => inUse.has(port)
  await assert.rejects(
    servePort('npm run preview', 3000, async () => 4000, taken),
    {
      message:
        'c.serve("npm run preview", 3000): port 3000 was already in use before c.serve started (a server the agent left running?), so the checks would reach that server, not this command\'s. Stop it first, or drop the port to serve on PORT',
    },
  )
  assert.equal(await servePort('npm run preview', 3001, async () => 4000, taken), 3001)
  let next = 4001
  assert.equal(await servePort('npm start', undefined, async () => next++, taken), 4002)
  await assert.rejects(
    servePort('npm start', undefined, async () => 3000, taken),
    {
      message:
        'c.serve("npm start") found every port it allocated for PORT already in use in the sandbox',
    },
  )
})

test('the probe script reads the listeners from /proc and whether the pid runs', {
  skip: linux,
}, async () => {
  const child = spawn(
    'node',
    [
      '-e',
      "require('net').createServer().listen(0, '::1', function () { console.log(this.address().port) })",
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  try {
    const [line] = (await once(child.stdout, 'data')) as [Buffer]
    const port = Number(line.toString().trim())
    const probe = parseProbe(
      spawnSync('sh', ['-c', probeScript(String(child.pid))]).stdout.toString(),
    )
    assert.ok(probe.proc && probe.alive)
    assert.ok(probe.listeners.some((l) => l.port === port && l.address === '::1'))
    const gone = parseProbe(spawnSync('sh', ['-c', probeScript('999999999')]).stdout.toString())
    assert.equal(gone.alive, false)
    assert.deepEqual(
      parseProbe(
        spawnSync('sh', ['-c', probeScript(String(process.pid), false)]).stdout.toString(),
      ),
      {
        proc: false,
        alive: true,
      },
    )
  } finally {
    child.kill('SIGKILL')
  }
})
