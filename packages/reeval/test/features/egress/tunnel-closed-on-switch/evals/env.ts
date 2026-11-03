import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const target = process.env.REEVAL_EGRESS_TARGET ?? 'missing.invalid:80'

/**
 * Opens a CONNECT tunnel to the listener through the gateway and holds it, writing `open` once
 * the gateway lets it through and `closed` when the gateway ends it.
 */
const hold = `const fs = require('node:fs')
const proxy = new URL(process.env.HTTP_PROXY)
const s = require('node:net').connect(Number(proxy.port), proxy.hostname, () =>
  s.write('CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n'),
)
let open = false
s.on('data', (d) => {
  if (open || !/ 200 /.test(String(d))) return
  open = true
  fs.writeFileSync('tunnel.txt', 'open')
})
s.on('error', () => {})
s.on('close', () => fs.writeFileSync('tunnel.txt', open ? 'closed' : 'refused'))
`

/** The setup step leaves the tunnel open, in the background, and returns once it is. */
const setup = [
  {
    run: 'setsid nohup node hold.cjs > /dev/null 2>&1 < /dev/null & for i in $(seq 50); do [ -s tunnel.txt ] && break; sleep 0.2; done; cat tunnel.txt',
  },
]
const files = { 'hold.cjs': hold }
/** The gateway reaches a private address, as the host's listener is, only when it's listed. */
const host = process.env.REEVAL_EGRESS_HOST ?? 'missing.invalid'

export const closed = defineEnvironment('closed', {
  sandbox,
  egress: { setup: { allow: [host] }, agent: 'deny-all' },
  files,
  setup,
})
export const kept = defineEnvironment('kept', {
  sandbox,
  egress: { setup: { allow: [host] }, agent: { allow: [host, 'example.com'] } },
  files,
  setup,
})

/** What became of the tunnel after the switch: the check waits for it to change. */
export const tunnel =
  'for i in $(seq 50); do [ "$(cat tunnel.txt)" != open ] && break; sleep 0.2; done; cat tunnel.txt'
