import { defineEnvironment } from 'reeval'
import { docker, podman } from 'reeval/sandbox'

const sandbox = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman() : docker()

// Like Vite: ignores PORT and listens on 5173, on IPv6 loopback only.
const server = `import http from 'node:http'
http
  .createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('vite')
  })
  .listen(5173, '::1')
`

const probe = `const [port] = process.argv.slice(2)
const r = await fetch('http://[::1]:' + port).then((r) => r.text(), () => 'down')
process.stdout.write(r)
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'vite.mjs': server, 'probe.mjs': probe },
})
