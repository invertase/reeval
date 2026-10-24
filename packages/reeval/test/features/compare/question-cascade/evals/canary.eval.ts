import { evaluate, expect, group } from 'reeval'
import { baseline, variant } from './env.ts'

// Must fail: the files the question is shown hold out.txt as the agent wrote it, not 'bye'.
group('parent', { question: { state: { diff: false } } }, () => {
  evaluate(
    'canary',
    {
      compare: { baseline, variants: [variant] },
      questions: [
        { question: 'Which change is smaller?', across: 'environment', state: { files: true } },
      ],
    },
    async (c) => {
      await c.send('write out.txt')
      expect(await c.readFile('out.txt')).toBe('bye\n')
    },
  )
})
