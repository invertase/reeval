// Preloaded (`node --import`) into a CLI that must stay offline: any TCP connection, DNS lookup
// or fetch is written to $ES_TEST_NETWORK_LOG and refused. Unix sockets (Docker's) are allowed.

import dns from 'node:dns'
import { appendFileSync } from 'node:fs'
import net from 'node:net'

const log = (what) => {
  if (process.env.ES_TEST_NETWORK_LOG) appendFileSync(process.env.ES_TEST_NETWORK_LOG, `${what}\n`)
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : {}
  const path =
    options.path ??
    (typeof args[0] === 'string' && Number.isNaN(Number(args[0])) ? args[0] : undefined)
  if (path === undefined) {
    log(`connect ${options.host ?? args[1] ?? ''}:${options.port ?? args[0]}`)
    throw new Error('network is off in this test')
  }
  return connect.apply(this, args)
}

dns.lookup = (host, ...rest) => {
  log(`dns ${host}`)
  const callback = rest.at(-1)
  if (typeof callback === 'function') callback(new Error('network is off in this test'))
}

globalThis.fetch = async (input) => {
  log(`fetch ${input}`)
  throw new Error('network is off in this test')
}
