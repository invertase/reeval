import { defineEnvironment, evaluate } from 'reeval'
import { tart } from 'reeval/sandbox'

const small = defineEnvironment('small', {
  sandbox: tart({
    image: 'ghcr.io/cirruslabs/macos-sequoia-base:latest',
    maxConcurrent: 1,
    cpus: 2,
    memory: '4g',
  }),
})

// At most two macOS VMs at once, whatever --concurrency asks for; one for the small environment.
evaluate('builds the app', { runs: 3 }, async () => {})
evaluate('builds it small', { environments: small, runs: 2 }, async () => {})
