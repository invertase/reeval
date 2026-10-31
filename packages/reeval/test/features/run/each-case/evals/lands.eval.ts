import { evaluate, expect } from 'reeval'
import { eachCase } from './env.ts'

evaluate.each([{ file: 'word.txt', word: 'ahoy' }])(
  'lands',
  { environments: eachCase },
  async (c, { file, word }) => {
    expect(await c.readFile(file)).toBe(word)
  },
)
