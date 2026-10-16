import { evaluate, expect } from 'reeval'
import { eachCase } from './env.ts'

evaluate.each([{ file: 'word.txt', word: 'ahoy' }])(
  'lands',
  { environment: eachCase },
  async (c, { file, word }) => {
    const box = await c.sandbox()
    expect(await box.readFile(file)).toBe(word)
  },
)
