import { evaluate, group } from 'evalsuite'

group.skip('parked', () => {
  evaluate('inside', async () => {})
  group('nested', () => {
    evaluate('deeper', async () => {})
  })
})
group.todo('someday')
