import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox, podman } from 'reeval/sandbox'

const tier = process.env.REEVAL_FIXTURE_SANDBOX
const sandbox =
  tier === 'podman'
    ? podman()
    : tier === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// Reads PORT, but opens a side port (a websocket or debugger, say) first.
const server = `import http from 'node:http'
http.createServer((_, res) => res.end('side')).listen(0, '127.0.0.1')
setTimeout(() => {
  http.createServer((_, res) => res.end('main')).listen(Number(process.env.PORT), '127.0.0.1')
}, 1500)
`

const probe = `const [port] = process.argv.slice(2)
const r = await fetch('http://127.0.0.1:' + port).then((r) => r.text(), () => 'down')
process.stdout.write(r)
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server, 'probe.mjs': probe },
})
