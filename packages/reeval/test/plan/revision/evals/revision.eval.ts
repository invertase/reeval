import { evaluate, group } from 'reeval'

group('versioned', { revision: 2, runs: 2, timeout: '2m' }, () => {
  evaluate('inherits', async () => {})
  evaluate('overrides', { revision: 'v3' }, async () => {})
})
evaluate('unversioned', async () => {})
evaluate('case', { cases: [1, 2], revision: 1 }, async () => {})
