import { defineEnvironment } from 'reeval'
import { docker, podman } from 'reeval/sandbox'

const sandbox = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman() : docker()

// Ignores PORT and listens on two ports of its own, so neither is the one to pick, and prints
// the URL of one in Vite's colors.
const server = `import http from 'node:http'
http.createServer((_, res) => res.end('preview')).listen(4173, '127.0.0.1')
http.createServer((_, res) => res.end('app')).listen(5173, '::1', () => {
  console.log('  \\x1b[32m➜\\x1b[39m  \\x1b[1mLocal\\x1b[22m:   \\x1b[36mhttp://localhost:\\x1b[1m5173\\x1b[22m/\\x1b[39m')
})
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server },
})
