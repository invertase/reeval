import { defineEnvironment, evaluate, expect } from 'reeval'

// A page that renders but logs, throws late, rejects a promise and loads a missing script; a page
// that throws before it renders; and a path the server answers with its 404 page.
const server = `import http from 'node:http'
http
  .createServer((req, res) => {
    if (req.url === '/missing.js') {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.url === '/blank') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><div id="root"></div><script>throw new Error("VITE_FIREBASE_API_KEY is not set")</script>')
      return
    }
    if (req.url !== '/sign-up') {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<!doctype html><h1>Page not found</h1>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><h1>Sign up</h1><script>console.log("rendered"); console.warn("auth is not configured")</script>' +
        '<script>throw new Error("late failure")</script><script>Promise.reject(new Error("no session"))</script>' +
        '<script src="/missing.js"></script>',
    )
  })
  .listen(Number(process.env.PORT), '127.0.0.1')
`

const site = defineEnvironment('site', { files: { 'server.mjs': server } })

evaluate('captures a page that renders', { environments: site }, async (c) => {
  await c.send('Build the sign-up page.')
  const app = await c.serve('node server.mjs')
  const shot = await c.capture(app, { name: 'sign-up', path: '/sign-up' })
  expect(shot.file.bytes).toBeGreaterThan(0)
})

evaluate('captures a page that throws', { environments: site }, async (c) => {
  await c.send('Build the sign-up page.')
  const app = await c.serve('node server.mjs')
  const shot = await c.capture(app, { name: 'blank', path: '/blank' })
  expect(shot.file.bytes).toBeGreaterThan(0)
})

evaluate('captures a missing page', { environments: site }, async (c) => {
  await c.send('Build the sign-up page.')
  const app = await c.serve('node server.mjs')
  const shot = await c.capture(app, { name: 'login', path: '/login' })
  expect(shot.file.bytes).toBeGreaterThan(0)
})
