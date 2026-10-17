import { evaluate, expect, group } from 'reeval'
import { baseline, ignored, variant } from './env.ts'

// The variant cell is only its own files. The parent's environment is not applied.
group('parent', { environment: ignored }, () => {
  evaluate('lands', { compare: { baseline, variants: [variant] } }, async (c) => {
    if (c.attempt.cell.role !== 'variant') return
    expect(await c.readFile('from-variant.txt')).toBe('variant-only')
    expect(await c.readFile('from-baseline.txt')).toBe(null)
    expect(await c.readFile('from-ignored.txt')).toBe(null)
  })
})
