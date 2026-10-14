import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const server = `import http from 'node:http'
const port = Number(process.env.PORT)
let second = false
const html = \`<!doctype html>
<title>wait</title>
<button id="go" style="position:fixed;left:20px;top:20px;width:60px;height:30px">go</button>
<script>
document.getElementById('go').onclick = () => {
  setTimeout(() => {
    fetch('/late').then(() => {
      const m = document.createElement('button')
      m.id = 'mark'
      m.setAttribute('style', 'position:fixed;left:200px;top:200px;width:60px;height:30px')
      m.onclick = () => fetch('/second')
      document.body.appendChild(m)
    })
  }, 400)
}
</script>
\`
http
  .createServer((req, res) => {
    if (req.url === '/late') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.url === '/second') {
      second = true
      res.writeHead(200)
      res.end('ok')
      return
    }
    if (req.url === '/state') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(second ? 'yes' : 'no')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  .listen(port, '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
