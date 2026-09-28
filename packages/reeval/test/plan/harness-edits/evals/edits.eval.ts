import { evaluate, group } from 'reeval'
import { cursor } from 'reeval/harness'

// The data forms of a harness edit plan the same cells as the functions they stand for.
const fast = cursor({ model: 'composer-2', id: 'fast' })

evaluate('add, as data', { harness: { add: fast } }, async () => {})
evaluate('add, as a function', { harness: (h) => [...h, fast] }, async () => {})
evaluate('only, as data', { harness: { only: 'cursor:composer-2.5' } }, async () => {})
evaluate('only, as a function', { harness: (h) => h.slice(0, 1) }, async () => {})

group('cursor only', { harness: { only: ['cursor:composer-2.5'] } }, () => {
  evaluate('then add', { harness: { add: [fast] } }, async () => {})
})
