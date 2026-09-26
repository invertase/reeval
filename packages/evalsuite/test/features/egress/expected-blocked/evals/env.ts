import { defineEnvironment } from 'evalsuite'

export const closed = defineEnvironment('closed', { egress: 'deny-all' })

/**
 * As the agent: the Antigravity CLI's telemetry and feature-flag hosts, then a host nothing
 * expects. reached.txt gets the CONNECT status and HTTP status of the telemetry request.
 */
export const calls = [
  "curl -sS -m 20 -o /dev/null -w '%{http_connect} %{http_code}' https://play.googleapis.com/log > reached.txt",
  'curl -sS -m 20 -o /dev/null https://antigravity-unleash.goog/api/',
  'curl -sS -m 20 -o /dev/null http://blocked.invalid/',
  'true',
].join('; ')
