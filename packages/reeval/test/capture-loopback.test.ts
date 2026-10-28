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
  assert.ok(isLoopbackHost('[::1]'))
  for (const host of ['example.com', '10.0.0.1', '128.0.0.1', 'localhost.example.com', '::2']) {
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

test('a port the sandbox cannot tunnel is a 502, and is asked for again next time', async () => {
  let calls = 0
  const proxy = await startLoopbackProxy({
    tunnel: async (port) => {
      calls++
      throw new Error(`Port ${port} isn't reachable`)
    },
    direct: [],
  })
  closers.push(() => proxy.close())
  assert.equal((await viaProxy(proxy.address, 'http://127.0.0.1:9099/')).status, 502)
  assert.match(await viaConnect(proxy.address, 'localhost:9099'), /^HTTP\/1\.1 502/)
  assert.equal(calls, 2)
})
