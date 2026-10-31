import { evaluate, expect } from 'reeval'
import { cases } from './env.ts'

evaluate(
  'lands',
  { cases: [{ id: 'ahoy', file: 'word.txt', word: 'ahoy' }], environments: cases },
  async (c, { file, word }) => {
    expect(await c.readFile(file)).toBe(word)
  },
)
