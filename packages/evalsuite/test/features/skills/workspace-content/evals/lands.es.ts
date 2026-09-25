import { evaluate, expect } from 'evalsuite'
import { greeting, staged } from './env.ts'

// The staged SKILL.md has ES's frontmatter (name, then the description folded to one line) and
// the body byte for byte.
evaluate('lands', { environment: greeting }, async (t) => {
  await t.send('noop')
  expect(await t.readFile(staged)).toBe(
    [
      '---',
      'name: house-greeting',
      `description: "The organisation's greeting style. Use when writing greetings."`,
      '---',
      '',
      '# House greeting',
      '',
      'Greet people with "Ahoy, <name>!".',
      '',
    ].join('\n'),
  )
})
