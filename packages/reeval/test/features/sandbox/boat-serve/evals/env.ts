import { defineEnvironment } from 'reeval'
import { boat } from 'reeval/sandbox/boat'

export const vm = defineEnvironment('vm', { sandbox: boat(), egress: 'allow-all' })

/** A server on PORT that answers `ok`. */
export const server = `node -e "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)"`

/** How many of the server's processes are left, after kill(). */
export const left = `pgrep -u reeval -f "[c]reateServer" | wc -l`
