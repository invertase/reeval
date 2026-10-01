import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const closed = defineEnvironment('closed', { sandbox, egress: 'deny-all' })

/** Writes the CONNECT status and the HTTP status of a request to `host` into reached.txt. */
export const reach = (host: string) =>
  `curl -sS -m 20 -o /dev/null -w '%{http_connect} %{http_code}' https://${host}/ > reached.txt`

export const prompt = `Run this exact shell command once, then stop: ${reach('api2.cursor.sh')}`
