import { defineEnvironment } from 'reeval'
import { docker, podman } from 'reeval/sandbox'

/** The Docker and Podman tiers run the same containers. */
const container = process.env.REEVAL_FIXTURE_SANDBOX === 'podman' ? podman : docker

export const small = defineEnvironment('small', { sandbox: container({ memory: '128m' }) })

/** Allocates and touches 2 GiB in Node, far past the limit. */
export const HOG = `node -e 'const b = []; for (let i = 0; i < 2048; i++) b.push(Buffer.alloc(1 << 20, 1))'`
