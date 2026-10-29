import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const server = `import http from 'node:http'
const port = Number(process.env.PORT)
let clicked = false
const html = \`<!doctype html>
<title>click</title>
<button id="go" style="position:fixed;left:100px;top:100px;width:80px;height:40px">Go</button>
<div id="after" hidden>after</div>
<script>
document.getElementById('go').onclick = () => {
  document.getElementById('after').hidden = false
  fetch('/clicked')
}
</script>
\`
http
  .createServer((req, res) => {
    if (req.url === '/clicked') {
      clicked = true
      res.writeHead(200)
      res.end('ok')
      return
    }
    if (req.url === '/state') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(clicked ? 'yes' : 'no')
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
