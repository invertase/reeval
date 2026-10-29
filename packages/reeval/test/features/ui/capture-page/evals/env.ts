import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// A page that renders, then logs, throws, rejects a promise and loads a script it doesn't have.
const server = `import http from 'node:http'
http
  .createServer((req, res) => {
    if (req.url === '/missing.js') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><title>app</title><h1>Sign up</h1>' +
        '<script>console.log("rendered"); console.warn("auth is not configured")</script>' +
        '<script>throw new Error("late failure")</script>' +
        '<script>Promise.reject(new Error("no session"))</script>' +
        '<script src="/missing.js"></script>',
    )
  })
  .listen(Number(process.env.PORT), '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
