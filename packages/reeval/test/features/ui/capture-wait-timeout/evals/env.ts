import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// Three in-flight requests keep Chromium above networkAlmostIdle (≤2 for ~500ms).
const server = `import http from 'node:http'
const port = Number(process.env.PORT)
http
  .createServer((req, res) => {
    if (req.url && req.url.startsWith('/hang')) return
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><title>busy</title><script>fetch("/hang1");fetch("/hang2");fetch("/hang3")</script><h1>busy</h1>',
    )
  })
  .listen(port, '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
