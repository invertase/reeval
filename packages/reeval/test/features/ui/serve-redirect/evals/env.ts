import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const server = `import http from 'node:http'
const port = Number(process.env.PORT)
http
  .createServer((_, res) => res.end('ok'))
  .listen(port, '127.0.0.1', () => console.log('listening on ' + port))
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})

/** Waits up to 20s for `path` to be non-empty, then prints it. */
export const readWhenWritten = (path: string) =>
  `for i in $(seq 200); do [ -s ${path} ] && break; sleep 0.1; done; cat ${path}`
