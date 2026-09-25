import { evaluate, group } from 'evalsuite'

group('slow things', { tags: ['slow'] }, () => {
  evaluate('big', async () => {})
  evaluate('bigger', { tags: ['flaky'] }, async () => {})
})
evaluate('quick', async () => {})
evaluate.for([{ n: 1 }, { n: 2 }])('case $n', { tags: ['slow'] }, async () => {})
