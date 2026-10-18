import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const server = `import http from 'node:http'
const port = Number(process.env.PORT)
http
  .createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>form</title><p class="error">email required</p>')
  })
  .listen(port, '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
