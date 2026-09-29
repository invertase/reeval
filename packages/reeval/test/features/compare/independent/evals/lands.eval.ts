import { evaluate, expect } from 'reeval'
import { baseline, ignored, variant } from './env.ts'

// The variant cell is only its own files. The baseline and the eval's environment stay out.
evaluate(
  'lands',
  { environment: ignored, compare: { baseline, variants: [variant] } },
  async (t) => {
    if (t.attempt.cell.role !== 'variant') return
    const box = await t.sandbox()
    expect(await box.readFile('from-variant.txt')).toBe('variant-only')
    expect(await box.readFile('from-baseline.txt')).toBe(null)
    expect(await box.readFile('from-ignored.txt')).toBe(null)
  },
)
