import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const server = `import http from 'node:http'
const port = Number(process.env.PORT)
const html = \`<!doctype html>
<title>tall</title>
<style>body{margin:0}#pad{height:2400px;background:#eee}</style>
<div id="pad">tall</div>
\`
http
  .createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  .listen(port, '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
