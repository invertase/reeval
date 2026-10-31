import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox, podman } from 'reeval/sandbox'

const tier = process.env.REEVAL_FIXTURE_SANDBOX
const sandbox =
  tier === 'podman'
    ? podman()
    : tier === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// Listens on PORT, or on the port given as its argument, as a dev server with a fixed port does.
const server = `import http from 'node:http'
const [name, port = process.env.PORT] = process.argv.slice(2)
http.createServer((_, res) => res.end(name)).listen(Number(port), '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
