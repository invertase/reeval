import { defineEnvironment } from 'reeval'
import { docker, podman } from 'reeval/sandbox'

const sandbox = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman() : docker()

/** The second server, on 9099 inside the sandbox only: it notes each Host it's called by. */
const api = `import http from 'node:http'
const hits = []
http
  .createServer((req, res) => {
    if (req.url === '/state') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(hits.sort().join(','))
      return
    }
    hits.push(req.headers.host.startsWith('localhost') ? 'name' : 'ip')
    res.writeHead(200, { 'access-control-allow-origin': '*' })
    res.end('ok')
  })
  .listen(9099, '127.0.0.1')
`

/** The served page calls ?port= by IP and by name, as an app calls its emulator. */
const page = `import http from 'node:http'
const html = \`<!doctype html>
<title>loopback</title>
<div id="out">calling</div>
<script>
const port = new URLSearchParams(location.search).get('port')
Promise.allSettled([
  fetch('http://127.0.0.1:' + port + '/hit'),
  fetch('http://localhost:' + port + '/hit'),
]).then((r) => { document.getElementById('out').textContent = r.map((x) => x.status).join(' ') })
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
