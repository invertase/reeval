import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { after, test } from 'node:test'
import { proxyArgs } from '../src/capture/browser.ts'
import { isLoopbackHost, startLoopbackProxy } from '../src/capture/loopback.ts'

const closers: Array<() => unknown> = []
after(async () => {
  for (const close of closers.reverse()) await close()
})

/** A host server that answers with its name and the request's Host and path. */
async function server(name: string): Promise<number> {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`${name} ${req.headers.host} ${req.url}`)
  })
  s.on('upgrade', (req, socket) => {
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: test\r\nconnection: upgrade\r\nx-from: ${name} ${req.url}\r\n\r\n`,
    )
  })
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise((ok) => s.close(ok)))
  return (s.address() as net.AddressInfo).port
}

/** A plain-HTTP request through the proxy, in absolute form, as Chrome sends one. */
function viaProxy(proxy: string, url: string): Promise<{ status: number; body: string }> {
  const [host, port] = proxy.split(':')
  return new Promise((ok, fail) => {
    const headers = { host: new URL(url).host }
    const req = http.request(
      { host, port: Number(port), path: url, headers, agent: false },
      (res) => {
        let body = ''
        res.on('data', (d) => {
          body += d
        })
        res.on('end', () => ok({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', fail)
    req.end()
  })
}

/** A CONNECT through the proxy, then one GET in the tunnel; resolves with the whole reply. */
function viaConnect(proxy: string, authority: string, path = '/'): Promise<string> {
  const [host, port] = proxy.split(':')
  return new Promise((ok, fail) => {
    const socket = net.connect({ host, port: Number(port) })
    let reply = ''
    socket.on('data', (d) => {
      reply += d
      if (reply.startsWith('HTTP/1.1 200') && !reply.includes('GET-SENT')) {
        reply += 'GET-SENT'
        socket.write(`GET ${path} HTTP/1.1\r\nhost: ${authority}\r\nconnection: close\r\n\r\n`)
      }
    })
    socket.on('end', () => ok(reply))
    socket.on('error', fail)
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`)
  })
}

test('isLoopbackHost names the addresses a page means the sandbox by', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1']) {
    assert.ok(isLoopbackHost(host), host)
  }
  for (const host of ['[::1]', 'localhost.', 'app.localhost.', '127.0.0.1.', '0.0.0.0', '[::]']) {
    assert.ok(isLoopbackHost(host), host)
  }
  for (const host of ['[::ffff:7f00:1]', '::ffff:7f12:3456', '::ffff:127.0.0.1']) {
    assert.ok(isLoopbackHost(host), host)
  }
  for (const host of [
    'example.com',
    'example.com.',
    '10.0.0.1',
    '128.0.0.1',
    'localhost.example.com',
    '::2',
    '::ffff:a00:1',
    '::ffff:10.0.0.1',
  ]) {
    assert.ok(!isLoopbackHost(host), host)
  }
})

test('proxyArgs sends loopback through the proxy, and adds nothing without one', () => {
  assert.deepEqual(proxyArgs('127.0.0.1:4000'), [
    '--proxy-server=http://127.0.0.1:4000',
    '--proxy-bypass-list=<-loopback>',
  ])
  assert.deepEqual(proxyArgs(undefined), [])
})

test('a loopback request goes to that port through its tunnel, opened once', async () => {
  const page = await server('page')
  const sandbox = await server('sandbox')
  const asked: number[] = []
  const proxy = await startLoopbackProxy({
    tunnel: async (port) => {
      asked.push(port)
      return `http://127.0.0.1:${sandbox}`
    },
    direct: [page],
  })
  closers.push(() => proxy.close())

  const a = await viaProxy(proxy.address, 'http://127.0.0.1:9099/emulator?x=1')
  assert.deepEqual(a, { status: 200, body: 'sandbox 127.0.0.1:9099 /emulator?x=1' })
  const b = await viaProxy(proxy.address, 'http://localhost:9099/again')
  assert.equal(b.body, 'sandbox localhost:9099 /again')
  assert.match(await viaConnect(proxy.address, '[::1]:9099', '/v6'), /sandbox \[::1\]:9099 \/v6/)
  assert.deepEqual(asked, [9099], 'one tunnel per sandbox port')
  assert.deepEqual(proxy.reached, [9099])

  const own = await viaProxy(proxy.address, `http://127.0.0.1:${page}/`)
  assert.equal(own.body, `page 127.0.0.1:${page} /`, "the served page's tunnel is the host's")
  assert.match(await viaConnect(proxy.address, `127.0.0.1:${page}`), /page 127\.0\.0\.1:/)
  assert.deepEqual(asked, [9099])
})

test('a WebSocket upgrade in absolute form reaches the sandbox port', async () => {
  const sandbox = await server('sandbox')
  const proxy = await startLoopbackProxy({
    tunnel: async () => `http://127.0.0.1:${sandbox}`,
    direct: [],
  })
  closers.push(() => proxy.close())
  const [host, port] = proxy.address.split(':')
  const reply = await new Promise<string>((ok, fail) => {
    const socket = net.connect({ host, port: Number(port) })
    let text = ''
    socket.on('data', (d) => {
      text += d
    })
    socket.on('end', () => ok(text))
    socket.on('error', fail)
    socket.write(
      'GET http://localhost:24678/hmr HTTP/1.1\r\nhost: localhost:24678\r\nconnection: upgrade\r\nupgrade: test\r\n\r\n',
    )
  })
  assert.match(reply, /^HTTP\/1\.1 101/)
  assert.match(reply, /x-from: sandbox \/hmr/)
})

test('a port the sandbox cannot tunnel fails like a refused one, and is asked for again', async () => {
  let calls = 0
  const proxy = await startLoopbackProxy({
    tunnel: async (port) => {
      calls++
      throw new Error(`Port ${port} isn't reachable`)
    },
    direct: [],
  })
  closers.push(() => proxy.close())
  await assert.rejects(viaProxy(proxy.address, 'http://127.0.0.1:9099/'), /socket hang up/)
  assert.match(await viaConnect(proxy.address, 'localhost:9099'), /^HTTP\/1\.1 502/)
  assert.equal(calls, 2)
  assert.deepEqual(proxy.reached, [])
})

test('a tunnel with nothing behind it drops a plain request, and is not named as reached', async () => {
  // The gateway's tunnel accepts, then closes once the sandbox side refuses.
  const hollow = net.createServer((socket) => socket.destroy())
  await new Promise<void>((ok) => hollow.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise((ok) => hollow.close(ok)))
  const at = (hollow.address() as net.AddressInfo).port
  const proxy = await startLoopbackProxy({
    tunnel: async () => `http://127.0.0.1:${at}`,
    direct: [],
  })
  closers.push(() => proxy.close())
  await assert.rejects(
    viaProxy(proxy.address, 'http://127.0.0.1:9097/'),
    /socket hang up|ECONNRESET/,
  )
  assert.deepEqual(proxy.reached, [])
})

/** A sandbox-side server that counts its open sockets and streams `/stream` until closed. */
async function counting(): Promise<{ port: number; open: () => number }> {
  let open = 0
  const s = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200)
      const timer = setInterval(() => res.write('tick\n'), 20)
      res.once('close', () => clearInterval(timer))
      return
    }
    res.end(JSON.stringify(req.rawHeaders))
  })
  s.on('connection', (socket) => {
    open++
    socket.once('close', () => open--)
  })
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise((ok) => s.close(ok)))
  return { port: (s.address() as net.AddressInfo).port, open: () => open }
}

const settle = (ms = 100) => new Promise((ok) => setTimeout(ok, ms))

test('a plain request the page abandons, or one in flight at close(), is torn down upstream', async () => {
  const sandbox = await counting()
  const proxy = await startLoopbackProxy({
    tunnel: async () => `http://127.0.0.1:${sandbox.port}`,
    direct: [],
  })
  const [host, port] = proxy.address.split(':')
  const stream = () =>
    new Promise<http.ClientRequest>((ok) => {
      const req = http.request({
        host,
        port: Number(port),
        path: 'http://127.0.0.1:9099/stream',
        headers: { host: '127.0.0.1:9099' },
        agent: false,
      })
      req.on('error', () => {})
      req.on('response', (res) => res.once('data', () => ok(req)))
      req.end()
    })
  ;(await stream()).destroy()
  await settle()
  assert.equal(sandbox.open(), 0, 'abandoned by the page')
  await stream()
  assert.equal(sandbox.open(), 1)
  await proxy.close()
  await settle()
  assert.equal(sandbox.open(), 0, 'in flight at close()')
})

test('close() while a tunnel is still opening leaves no socket behind', async () => {
  const sandbox = await counting()
  let release!: () => void
  const gate = new Promise<void>((ok) => {
    release = ok
  })
  const proxy = await startLoopbackProxy({
    tunnel: async () => {
      await gate
      return `http://127.0.0.1:${sandbox.port}`
    },
    direct: [],
  })
  const [host, port] = proxy.address.split(':')
  const client = net.connect({ host, port: Number(port) })
  client.on('error', () => {})
  client.write('CONNECT localhost:9099 HTTP/1.1\r\nhost: localhost:9099\r\n\r\n')
  await settle(50)
  await proxy.close()
  release()
  await settle()
  assert.equal(sandbox.open(), 0)
})

test('a page that resets while its CONNECT or upgrade is opening does not crash the worker', async () => {
  const sandbox = await counting()
  let release!: () => void
  const gate = new Promise<void>((ok) => {
    release = ok
  })
  const proxy = await startLoopbackProxy({
    tunnel: async () => {
      await gate
      return `http://127.0.0.1:${sandbox.port}`
    },
    direct: [],
  })
  closers.push(() => proxy.close())
  const [host, port] = proxy.address.split(':')
  const requests = [
    'CONNECT localhost:9099 HTTP/1.1\r\nhost: localhost:9099\r\n\r\n',
    'GET http://localhost:9098/ HTTP/1.1\r\nhost: localhost:9098\r\nconnection: upgrade\r\nupgrade: test\r\n\r\n',
  ]
  for (const request of requests) {
    const client = net.connect({ host, port: Number(port) })
    client.on('error', () => {})
    await new Promise((ok) => client.once('connect', ok))
    client.write(request)
    await settle(50)
    client.resetAndDestroy()
  }
  await settle(50)
  release()
  await settle()
  assert.equal(sandbox.open(), 0)
})

test('both paths forward the raw headers, repeats included, without proxy-*', async () => {
  const sandbox = await counting()
  const proxy = await startLoopbackProxy({
    tunnel: async () => `http://127.0.0.1:${sandbox.port}`,
    direct: [],
  })
  closers.push(() => proxy.close())
  const [host, port] = proxy.address.split(':')
  const reply = await new Promise<string>((ok, fail) => {
    const socket = net.connect({ host, port: Number(port) })
    let text = ''
    socket.on('data', (d) => {
      text += d
    })
    socket.on('end', () => ok(text))
    socket.on('error', fail)
    socket.write(
      'GET http://127.0.0.1:9099/h HTTP/1.1\r\nHost: 127.0.0.1:9099\r\nX-Twice: a\r\nX-Twice: b\r\nProxy-Connection: keep-alive\r\nConnection: close\r\n\r\n',
    )
  })
  const body = JSON.parse(reply.slice(reply.indexOf('\r\n\r\n') + 4)) as string[]
  assert.deepEqual(
    body.filter((_, i) => i % 2 === 0 && /^x-twice$/i.test(body[i] ?? '')).length,
    2,
    'both X-Twice lines',
  )
  assert.ok(!body.some((h) => /^proxy-/i.test(h)))
  assert.deepEqual(proxy.reached, [9099])
})
