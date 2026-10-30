import { randomUUID } from 'node:crypto'
import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const plain = defineEnvironment('plain', { sandbox })

// drand's beacon publishes a fresh random value every 30 seconds that nobody knows in advance and
// that never changes once published, so only a real fetch during the turn can report a recent
// round, and the test reads the same round back from drand to check it. The per-run query
// parameter keeps a cached fetch of the page from answering for it.
export const url = `https://api.drand.sh/public/latest?reeval=${randomUUID()}`

export const prompt =
  `Use your built-in web fetch tool (not the shell, not curl) to fetch ${url} . ` +
  'Reply with its round and randomness values, separated by a space, and nothing else.'

export const beacon = /\b(\d+)\s+([0-9a-f]{64})\b/

// The default chain's parameters (https://api.drand.sh/info), fixed for the chain's lifetime.
const GENESIS_S = 1595431050
const PERIOD_S = 30
const RELAYS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://drand.cloudflare.com']

/** When drand published `round`, in epoch milliseconds. */
export const publishedAt = (round: number) => (GENESIS_S + (round - 1) * PERIOD_S) * 1000

/** The randomness drand published for `round`, from the first relay that answers. */
export async function randomness(round: number): Promise<string> {
  const errors: string[] = []
  for (const relay of RELAYS) {
    try {
      const res = await fetch(`${relay}/public/${round}`, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) return ((await res.json()) as { randomness: string }).randomness
      errors.push(`${relay}: HTTP ${res.status}`)
    } catch (error) {
      errors.push(`${relay}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`no drand relay served round ${round}: ${errors.join('; ')}`)
}
