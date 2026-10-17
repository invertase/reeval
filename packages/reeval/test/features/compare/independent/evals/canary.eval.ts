import { evaluate, expect, group } from 'reeval'
import { baseline, ignored, variant } from './env.ts'

// Must fail: compare does not layer the baseline into the variant.
group('parent', { environment: ignored }, () => {
  evaluate('canary', { compare: { baseline, variants: [variant] } }, async (c) => {
    if (c.attempt.cell.role !== 'variant') return
    expect(await c.readFile('from-baseline.txt')).toBe('baseline-only')
  })
})
