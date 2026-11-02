import { evaluate, expect } from 'reeval'
import { greeting, staged } from './env.ts'

// The staged SKILL.md has reeval's frontmatter (name, then the description folded to one line) and
// the body byte for byte.
evaluate('lands', { environments: greeting }, async (c) => {
  expect(await c.readFile(staged)).toBe(
    [
      '---',
      'name: house-greeting',
      `description: "The organization's greeting style. Use when writing greetings."`,
      '---',
      '',
      '# House greeting',
      '',
      'Greet people with "Ahoy, <name>!".',
      '',
    ].join('\n'),
  )
})
