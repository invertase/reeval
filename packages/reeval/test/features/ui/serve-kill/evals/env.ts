import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const server = `import http from 'node:http'
http.createServer((_, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')
`

// Polls the port for up to 20s until it is `want` ('up' or 'down'), then prints what it is.
const probe = `const [port, want] = process.argv.slice(2)
const state = () =>
  fetch('http://127.0.0.1:' + port).then(() => 'up', () => 'down')
let now = await state()
for (let i = 0; i < 200 && now !== want; i++) {
  await new Promise((r) => setTimeout(r, 100))
  now = await state()
}
process.stdout.write(now)
`

export const ui = defineEnvironment('ui', {
  sandbox,
  files: { 'server.mjs': server, 'probe.mjs': probe },
})
