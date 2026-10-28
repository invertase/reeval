import { evaluate, expect } from 'reeval'

const slugifies = (input: string, slug: string) =>
  `node -e "import('./src/slug.js').then((m) => process.exit(m.slugify('${input}') === '${slug}' ? 0 : 1))"`

evaluate('writes slugify', async (c) => {
  await c.send(
    'Write src/slug.js exporting slugify(text): lower-case, words joined by single hyphens, ' +
      'no leading or trailing hyphen. Add a package.json with "type": "module".',
  )
  await expect.soft(c, 'writes the module').toHaveFile('src/slug.js', /export/)
  await expect
    .soft(c.exec(slugifies('Hello World', 'hello-world')), 'slugifies a title')
    .toSucceed()
  await expect
    .soft(c.exec(slugifies('  Ahoy, Ada!  ', 'ahoy--ada')), 'trims punctuation')
    .toSucceed()
  expect(await c.judge('Is slugify short and readable?', { contents: ['src/slug.js'] })).toPass()
})
