import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// `/old` redirects to `/login`, which the server answers with its 404 page.
const server = `import http from 'node:http'
http
  .createServer((req, res) => {
    if (req.url === '/old') {
      res.writeHead(302, { location: '/login' })
      res.end()
      return
    }
    res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' })
    res.end(req.url === '/' ? '<!doctype html><h1>Home</h1>' : '<!doctype html><h1>Page not found</h1>')
  })
  .listen(Number(process.env.PORT), '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
