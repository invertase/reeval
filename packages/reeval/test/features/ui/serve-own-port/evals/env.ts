import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox, podman } from 'reeval/sandbox'

const tier = process.env.REEVAL_FIXTURE_SANDBOX
const inContainer = tier === 'docker' || tier === 'podman'
const sandbox =
  tier === 'podman'
    ? podman()
    : tier === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// Like Vite: ignores PORT and listens on its own port, on IPv6 loopback only. In a container that's
// 5173; on the shared host it's any free port, so two attempts don't collide.
const server = `import http from 'node:http'
http
  .createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('vite')
  })
  .listen(${inContainer ? 5173 : 0}, '::1')
`

const probe = `const [port] = process.argv.slice(2)
const r = await fetch('http://[::1]:' + port).then((r) => r.text(), () => 'down')
process.stdout.write(r)
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'vite.mjs': server, 'probe.mjs': probe },
})
