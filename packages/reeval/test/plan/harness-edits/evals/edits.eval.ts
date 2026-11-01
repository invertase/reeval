import { evaluate, group } from 'reeval'
import { cursor } from 'reeval/harness'

// The data forms of a harness edit plan the same cells as the functions they stand for.
const fast = cursor({ model: 'composer-2', id: 'fast' })

evaluate('add, as data', { harnesses: { add: fast } }, async () => {})
evaluate('add, as a function', { harnesses: (h) => [...h, fast] }, async () => {})
evaluate('only, as data', { harnesses: { only: 'cursor:composer-2.5' } }, async () => {})
evaluate('only, as a function', { harnesses: (h) => h.slice(0, 1) }, async () => {})

group('cursor only', { harnesses: { only: ['cursor:composer-2.5'] } }, () => {
  evaluate('then add', { harnesses: { add: [fast] } }, async () => {})
})
