// Compile-time checks of `cases`, run by `pnpm typecheck` (tsconfig.json here): the body's case
// is typed from the list in either argument order, a body that takes a case needs `cases`, and
// `caseKey` takes the case's type. An unused `@ts-expect-error` fails the build too.
import { defineEnvironment, evaluate, group } from '../../src/index.ts'

const app = defineEnvironment('app', {})
const skilled = defineEnvironment('skilled', {})

evaluate('strings', { cases: ['users', 'posts'] }, async (_c, item) => {
  const literal: 'users' | 'posts' = item
  void literal
})
evaluate(
  'objects, options last',
  async (_c, task) => {
    const id: string = task.id
    const n: number = task.n
    void [id, n]
  },
  { cases: [{ id: 'a', n: 1 }], runs: 2 },
)
evaluate(
  'a key',
  { cases: [{ slug: 'a' }, { slug: 'b' }], caseKey: (t) => t.slug },
  async (_c, t) => void t.slug,
)
evaluate(
  'with a compare',
  { cases: [1, 2], compare: { control: app, variants: [skilled] } },
  async () => {},
)
evaluate.skip('skipped', { cases: ['a'] }, async (_c, item) => void item)
evaluate('no cases', async () => {})

// @ts-expect-error a body taking a case needs cases
evaluate('no list', {}, async (_c, item: string) => void item)
// @ts-expect-error the case is a string, not a number
evaluate('wrong type', { cases: ['a'] }, async (_c, item: number) => void item)
// @ts-expect-error caseKey returns a string
evaluate('a bad key', { cases: [{ n: 1 }], caseKey: (t) => t.n }, async () => {})
// @ts-expect-error a group takes no cases
group('a group', { cases: ['a'] }, () => {})
