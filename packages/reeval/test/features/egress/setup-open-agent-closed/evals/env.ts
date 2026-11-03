import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox, podman } from 'reeval/sandbox'

/** The Docker and Podman tiers run the same containers. */
const container = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman : docker

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker' || process.env.REEVAL_FIXTURE_SANDBOX === 'podman'
    ? container()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const target = `http://${process.env.REEVAL_EGRESS_TARGET}/`

/** Reaches the host's listener around the proxy, printing the status and curl's exit code. */
export const direct = `curl -s -m 5 -o /dev/null -w '%{http_code}' --noproxy '*' ${target}; echo " exit=$?"`

/** The setup step reaches the listener directly, then through the gateway. */
const setup = [
  { run: `{ ${direct}; } > setup.txt` },
  { run: `curl -sS -m 10 -o /dev/null ${target}` },
]

export const phased = defineEnvironment('phased', {
  sandbox,
  egress: { setup: 'allow-all', agent: 'deny-all' },
  setup,
})
export const open = defineEnvironment('open', { sandbox, egress: 'allow-all', setup })

/** What each of the scripted agent's shell commands printed. */
export const agentSaw = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'tool' && e.tool === 'shell' ? [e.output] : []))
