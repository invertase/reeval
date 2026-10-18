import { evaluate, expect, group } from 'reeval'
import { baseline, variant } from './env.ts'

// question.state merges key by key: output from the config, diff off from the group, files from
// the entry.
group('parent', { question: { state: { diff: false } } }, () => {
  evaluate(
    'lands',
    {
      compare: {
        baseline,
        variants: [variant],
        questions: [{ question: 'Which change is smaller?', state: { files: true } }],
      },
    },
    async (c) => {
      await c.send('write out.txt')
      expect(await c.readFile('out.txt')).toBe('hi\n')
    },
  )
})
