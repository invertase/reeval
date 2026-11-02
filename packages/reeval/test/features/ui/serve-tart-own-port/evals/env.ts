import { defineEnvironment } from 'reeval'
import { tart } from 'reeval/sandbox'

// Ignores PORT and listens on a port the OS picks, so only the VM's own listeners name it.
const server = `import http from 'node:http'
http
  .createServer((_, res) => res.end('own port'))
  .listen(0, '127.0.0.1')
`

const probe = `const [port] = process.argv.slice(2)
const r = await fetch('http://127.0.0.1:' + port).then((r) => r.text(), () => 'down')
process.stdout.write(r)
`

export const ui = defineEnvironment('ui', {
  sandbox: tart({ image: 'ghcr.io/cirruslabs/macos-sequoia-base:latest' }),
  egress: 'allow-all',
  files: { 'own-port.mjs': server, 'probe.mjs': probe },
})
