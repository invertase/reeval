import { defineEnvironment } from 'reeval'
import { docker, podman } from 'reeval/sandbox'

const sandbox = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman() : docker()

/**
 * The second server, on 9099 inside the sandbox only. It notes each Host a `/hit` came by, a
 * WebSocket handshake, and what the page reports in `/note`; `/state` waits for six notes.
 */
const api = `import { createHash } from 'node:crypto'
import http from 'node:http'
const notes = []
const waiting = new Set()
const note = (what) => {
  notes.push(what)
  for (const done of waiting) done()
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/state') {
    const reply = () => {
      clearTimeout(timer)
      waiting.delete(check)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(notes.sort().join(','))
    }
    const check = () => notes.length >= 6 && reply()
    const timer = setTimeout(reply, 15000)
    waiting.add(check)
    check()
    return
  }
  if (url.pathname === '/hit') {
    const host = req.headers.host
    note(host.startsWith('localhost') ? 'name' : host.startsWith('[::1]') ? 'v6' : 'ip')
  }
  if (url.pathname === '/note') note(url.searchParams.get('what'))
  res.writeHead(200, { 'access-control-allow-origin': '*' })
  res.end('ok')
})
server.on('upgrade', (req, socket) => {
  note('ws')
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.end('HTTP/1.1 101 Switching Protocols\\r\\nupgrade: websocket\\r\\nconnection: upgrade\\r\\nsec-websocket-accept: ' + accept + '\\r\\n\\r\\n')
})
server.listen(9099, '127.0.0.1')
`

/**
 * The served page calls ?port= by IP, by name, by IPv6 and over a WebSocket, as an app calls its
 * emulator. It reports there whether ?host= (a host-only server, not loopback) answered and
 * whether 9097 (nothing listens) failed as a refused port does.
 */
const page = `import http from 'node:http'
const html = \`<!doctype html>
<title>loopback</title>
<div id="out">calling</div>
<script>
const q = new URLSearchParams(location.search)
const port = q.get('port')
const note = (what) => fetch('http://127.0.0.1:' + port + '/note?what=' + what)
for (const host of ['127.0.0.1', 'localhost', '[::1]']) fetch('http://' + host + ':' + port + '/hit')
new WebSocket('ws://localhost:' + port + '/')
fetch('http://' + q.get('host') + '/', { mode: 'no-cors' }).then(() => note('host'), () => note('no-host'))
fetch('http://127.0.0.1:9097/', { mode: 'no-cors' }).then(() => note('answered'), () => note('refused'))
</script>
\`
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  .listen(Number(process.env.PORT), '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'api.mjs': api, 'page.mjs': page },
})

export const state = `node -e "fetch('http://127.0.0.1:9099/state').then(r=>r.text()).then(t=>process.stdout.write(t))"`

export const query = (port: number) =>
  `/?port=${port}&host=${encodeURIComponent(process.env.REEVAL_EGRESS_TARGET ?? '')}`
