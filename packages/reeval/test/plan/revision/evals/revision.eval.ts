import { evaluate, group } from 'reeval'

group('versioned', { revision: 2, runs: 2, timeout: '2m' }, () => {
  evaluate('inherits', async () => {})
  evaluate('overrides', { revision: 'v3' }, async () => {})
})
evaluate('unversioned', async () => {})
evaluate.each([{ n: 1 }, { n: 2 }])('case $n', { revision: 1 }, async () => {})
