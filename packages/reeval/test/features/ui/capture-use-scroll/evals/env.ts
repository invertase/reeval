import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// / is 3000 px with its link at the bottom; /top's button is in its first window, which the
// window scrolled to the link on / is not.
const server = `import http from 'node:http'
const port = Number(process.env.PORT)
let clicked = false
const pages = {
  '/': \`<!doctype html><body style="margin:0"><div style="height:2900px"></div>
<a href="/top" style="display:block;height:60px">Next</a></body>\`,
  '/top': \`<!doctype html><body style="margin:0"><div style="height:3000px">
<button style="margin-top:470px;height:60px;width:200px" onclick="fetch('/clicked')">Go</button>
</div></body>\`,
}
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
    res.end(pages[req.url] ?? '')
  })
  .listen(port, '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
