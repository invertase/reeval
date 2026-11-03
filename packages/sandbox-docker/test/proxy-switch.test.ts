import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { test } from 'node:test'
import { createCertificateAuthority } from '../src/egress/cert.ts'
import { createEgressProxy } from '../src/egress/proxy.ts'

/** The proxy on a local port, its lookups taking `delayMs`. */
async function start(delayMs: number) {
  const proxy = createEgressProxy({
    ca: createCertificateAuthority(),
    policy: { mode: 'allow-all' },
    log: () => {},
    lookup: async () => {
      await new Promise((r) => setTimeout(r, delayMs))
      return ['127.0.0.1']
    },
    allowLoopback: true,
  })
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.once('close', () => sockets.delete(s))
    proxy.handle(s)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    proxy,
    port: (server.address() as net.AddressInfo).port,
    close() {
      proxy.close()
      for (const s of sockets) s.destroy()
      server.close()
    },
  }
}

async function listen(server: net.Server) {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as net.AddressInfo).port
}

test('switchPolicy: a CONNECT whose lookup is pending at the switch gets the next policy', async () => {
  const echo = net.createServer((s) => s.pipe(s))
  const port = await listen(echo)
  const gw = await start(200)
  try {
    await gw.proxy.switchPolicy({ mode: 'allow-all' }, 'setup')
    const status = new Promise<number>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: gw.port,
        method: 'CONNECT',
        path: `slow.test:${port}`,
      })
      req.once('connect', (res, socket) => {
        resolve(res.statusCode ?? 0)
        socket.destroy()
      })
      req.end()
    })
    await new Promise((r) => setTimeout(r, 50))
    await gw.proxy.switchPolicy({ mode: 'deny-all' }, 'agent')
    assert.equal(await status, 403)
    assert.deepEqual(gw.proxy.traffic().contacted, [])
  } finally {
    gw.close()
    echo.close()
  }
})

test('switchPolicy: a plain-HTTP request in flight at the switch is closed', async () => {
  let received = 0
  const upstream = http.createServer((req, res) => {
    req.on('data', (d: Buffer) => {
      received += d.length
    })
    req.on('end', () => res.end('ok'))
  })
  const port = await listen(upstream)
  const gw = await start(0)
  try {
    await gw.proxy.switchPolicy({ mode: 'allow-all' }, 'setup')
    const req = http.request({
      host: '127.0.0.1',
      port: gw.port,
      method: 'POST',
      path: `http://upload.test:${port}/`,
      headers: { 'transfer-encoding': 'chunked' },
    })
    const closed = new Promise<void>((r) => req.once('error', () => r()))
    req.write('setup ')
    await new Promise((r) => setTimeout(r, 100))
    await gw.proxy.switchPolicy({ mode: 'deny-all' }, 'agent')
    const before = received
    req.write('what the agent wrote')
    await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))])
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(received, before, 'nothing reaches the refused host after the switch')
    assert.deepEqual(
      gw.proxy.traffic().blocked.map((b) => [b.host, b.phase, b.closed]),
      [['upload.test', 'agent', true]],
    )
  } finally {
    gw.close()
    upstream.closeAllConnections()
    upstream.close()
  }
})
