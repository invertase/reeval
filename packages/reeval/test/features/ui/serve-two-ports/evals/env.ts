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

// Ignores PORT and listens on two ports of its own, so neither is the one to pick. In a container
// they're 5173 and 24678; on the shared host any free ones.
const [app, hmr] = inContainer ? [5173, 24678] : [0, 0]
const server = `import http from 'node:http'
http.createServer((_, res) => res.end('app')).listen(${app}, '127.0.0.1')
http.createServer((_, res) => res.end('hmr')).listen(${hmr}, '127.0.0.1')
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
