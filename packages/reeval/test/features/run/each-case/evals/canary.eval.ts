import { evaluate, expect } from 'reeval'
import { eachCase } from './env.ts'

// Must fail: the case's word isn't the file's.
evaluate.each([{ file: 'word.txt', word: 'hello' }])(
  'canary',
  { environment: eachCase },
  async (c, { file, word }) => {
    const box = await c.sandbox()
    expect(await box.readFile(file)).toBe(word)
  },
)
