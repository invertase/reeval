import { evaluate, group } from 'reeval'

group.skip('parked', () => {
  evaluate('inside', async () => {})
  group('nested', () => {
    evaluate('deeper', async () => {})
  })
})
group.todo('someday')
