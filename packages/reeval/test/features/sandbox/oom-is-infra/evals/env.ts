import { defineEnvironment } from 'reeval'
import { docker } from 'reeval/sandbox'

export const small = defineEnvironment('small', { sandbox: docker({ memory: '128m' }) })

/** Allocates and touches 2 GiB in Node, far past the limit. */
export const HOG = `node -e 'const b = []; for (let i = 0; i < 2048; i++) b.push(Buffer.alloc(1 << 20, 1))'`
