import { evaluate, expect, group } from 'reeval'
import { inherited, variant } from './env.ts'

// No baseline: the control cell runs in the parent group's environment.
group('parent', { environments: inherited }, () => {
  evaluate('lands', { compare: { variants: [variant], gate: 'all' } }, async (c) => {
    if (c.attempt.cell.role !== 'control') return
    expect(await c.readFile('from-inherited.txt')).toBe('inherited')
  })
})
