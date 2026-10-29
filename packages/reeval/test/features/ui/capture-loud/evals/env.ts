import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// A page that logs 1,300 lines and one of 5 MB, and rejects a promise it handles later.
const server = `import http from 'node:http'
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><title>app</title><h1>Loud</h1>' +
        '<script>for (let i = 0; i < 1300; i++) console.log("log " + i)</script>' +
        '<script>console.log("x".repeat(5 * 1024 * 1024))</script>' +
        '<script>window.p = Promise.reject(new Error("handled later"));' +
        ' setTimeout(() => window.p.catch(() => {}), 200)</script>',
    )
  })
  .listen(Number(process.env.PORT), '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
