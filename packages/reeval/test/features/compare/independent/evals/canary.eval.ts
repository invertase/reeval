import { evaluate, expect, group } from 'reeval'
import { baseline, ignored, variant } from './env.ts'

// Must fail: compare does not layer the baseline into the variant.
group('parent', { environment: ignored }, () => {
  evaluate('canary', { compare: { baseline, variants: [variant] } }, async (t) => {
    if (t.attempt.cell.role !== 'variant') return
    const box = await t.sandbox()
    expect(await box.readFile('from-baseline.txt')).toBe('baseline-only')
  })
})
