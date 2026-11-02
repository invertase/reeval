import { evaluate, group } from 'reeval'

group('slow things', { tags: ['slow'] }, () => {
  evaluate('big', async () => {})
  evaluate('bigger', { tags: ['flaky'] }, async () => {})
})
evaluate('quick', async () => {})
evaluate('case', { cases: [1, 2], tags: ['slow'] }, async () => {})
