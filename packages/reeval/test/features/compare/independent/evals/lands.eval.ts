import { evaluate, expect, group } from 'reeval'
import { baseline, ignored, variant } from './env.ts'

// The variant cell is only its own files. The parent's environment is not applied.
group('parent', { environment: ignored }, () => {
  evaluate('lands', { compare: { baseline, variants: [variant] } }, async (t) => {
    if (t.attempt.cell.role !== 'variant') return
    const box = await t.sandbox()
    expect(await box.readFile('from-variant.txt')).toBe('variant-only')
    expect(await box.readFile('from-baseline.txt')).toBe(null)
    expect(await box.readFile('from-ignored.txt')).toBe(null)
  })
})
