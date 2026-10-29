import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const server = `import http from 'node:http'
const port = Number(process.env.PORT)
let signedUp = ''
const field = (top) => \`position:fixed;left:100px;top:\${top}px;width:200px;height:30px\`
const form = \`<!doctype html>
<title>sign up</title>
<input id="email" style="\${field(100)}">
<input id="password" type="password" style="\${field(150)}">
<button id="go" style="\${field(200)}">Sign up</button>
<script>
document.getElementById('go').onclick = async () => {
  const body = JSON.stringify({ email: email.value, password: password.value })
  await fetch('/sign-up', { method: 'POST', body })
  location.href = '/welcome'
}
</script>
\`
http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/sign-up') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const { email, password } = JSON.parse(body)
        signedUp = password === 'Test1234!' ? email : ''
        res.end('ok')
      })
      return
    }
    if (req.url === '/state') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(signedUp || 'nobody')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url === '/welcome' ? '<h1>Welcome</h1>' : form)
  })
  .listen(port, '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
