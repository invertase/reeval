import { evaluate } from 'reeval'

evaluate.only('focused', async () => {})
evaluate('sibling', async () => {})
evaluate.skip('skipped', async () => {})
evaluate.todo('later')
