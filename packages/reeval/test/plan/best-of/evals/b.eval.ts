import { evaluate, group } from 'reeval'

evaluate('best of 3', { runs: { bestOf: 3 } }, async () => {})
evaluate('best of 5 over a gate', { runs: { bestOf: 5 }, gate: 'all' }, async () => {})
group('best of 3 for the group', { runs: { bestOf: 3 } }, () => {
  evaluate('inherits it', async () => {})
  evaluate('a fixed count of its own', { runs: 2 }, async () => {})
})
evaluate('fixed', async () => {})
