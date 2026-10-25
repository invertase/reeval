import { evaluate, group } from 'reeval'

group.skip('parked', () => {
  evaluate.only('focused', async () => {})
  evaluate('inside', async () => {})
  group.only('nested', () => {
    evaluate('deeper', async () => {})
  })
})
evaluate('outer', async () => {})
