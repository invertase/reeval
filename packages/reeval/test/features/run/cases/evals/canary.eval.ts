import { evaluate, expect } from 'reeval'
import { cases } from './env.ts'

// Must fail: the case's word isn't the file's.
evaluate(
  'canary',
  { cases: [{ id: 'hello', file: 'word.txt', word: 'hello' }], environments: cases },
  async (c, { file, word }) => {
    expect(await c.readFile(file)).toBe(word)
  },
)
