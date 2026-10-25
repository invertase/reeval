import { evaluate, group } from 'reeval'

group.skip('parked', () => {
  evaluate.only('focused', async () => {})
  evaluate('inside', async () => {})
  group.only('nested', () => {
    evaluate('deeper', async () => {})
  })
  group.skip('shelved', () => {
    evaluate('buried', async () => {})
    evaluate.only('buried focus', async () => {})
  })
})
evaluate('outer', async () => {})
