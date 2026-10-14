import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const server = `import http from 'node:http'
const port = Number(process.env.PORT)
http
  .createServer((req, res) => {
    if (req.url === '/data') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><title>ok</title><script>fetch("/data")</script><h1>ok</h1>',
    )
  })
  .listen(port, '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
