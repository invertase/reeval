import { defineEnvironment, evaluate, expect } from 'reeval'

const servers = defineEnvironment('servers', {
  files: {
    'reads-port.mjs': `import http from 'node:http'
http.createServer((_, res) => res.end('port')).listen(Number(process.env.PORT), '127.0.0.1')
`,
    'own-port.mjs': `import http from 'node:http'
http.createServer((_, res) => res.end('own')).listen(0, '::1')
`,
  },
})

evaluate('serves on PORT', { environment: servers }, async (c) => {
  const app = await c.serve('node reads-port.mjs')
  expect((await c.exec(`curl -s 127.0.0.1:${app.port}`)).stdout).toBe('port')
})

evaluate('serves on its own port', { environment: servers }, async (c) => {
  const app = await c.serve('node own-port.mjs')
  expect((await c.exec(`curl -s -g '[::1]:${app.port}'`)).stdout).toBe('own')
})
