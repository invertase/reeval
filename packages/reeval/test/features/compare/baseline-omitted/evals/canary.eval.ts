import { evaluate, expect, group } from 'reeval'
import { inherited, variant } from './env.ts'

// Must fail: the control is the inherited environment, not layered with the variant. gate: 'all' gates the control.
group('parent', { environment: inherited }, () => {
  evaluate('canary', { compare: { variants: [variant], gate: 'all' } }, async (c) => {
    if (c.attempt.cell.role !== 'control') return
    const box = await c.sandbox()
    expect(await box.readFile('from-variant.txt')).toBe('variant-only')
  })
})
