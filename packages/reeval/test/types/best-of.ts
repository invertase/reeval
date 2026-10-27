// Compile-time checks of `runs: { bestOf }`, run by `pnpm typecheck` (tsconfig.json here): an
// inline literal that isn't odd and 3 or more is a type error, and a value typed `number` is not,
// so the run-time check refuses it instead. An unused `@ts-expect-error` fails the build too.
import { evaluate, group } from '../../src/index.ts'

const body = async () => {}

evaluate('best of 3', { runs: { bestOf: 3 } }, body)
evaluate('best of 5', { runs: { bestOf: 5 } }, body)
evaluate('best of 21', { runs: { bestOf: 21 } }, body)
evaluate('a fixed count', { runs: 4 }, body)
group('a group', { runs: { bestOf: 7 } }, () => {})
evaluate.skip('skipped', { runs: { bestOf: 3 } }, body)
evaluate.only('only', { runs: { bestOf: 9 } }, body)

// @ts-expect-error even
evaluate('best of 4', { runs: { bestOf: 4 } }, body)
// @ts-expect-error below 3
evaluate('best of 1', { runs: { bestOf: 1 } }, body)
// @ts-expect-error not whole
evaluate('best of 3.5', { runs: { bestOf: 3.5 } }, body)
// @ts-expect-error negative
evaluate('best of -3', { runs: { bestOf: -3 } }, body)
// @ts-expect-error even, in a group
group('a group of 6', { runs: { bestOf: 6 } }, () => {})
// @ts-expect-error even, skipped
evaluate.skip('best of 2', { runs: { bestOf: 2 } }, body)
// @ts-expect-error an unknown key
evaluate('min', { runs: { bestOf: 3, min: 2 } }, body)

declare const n: number
evaluate('a number', { runs: { bestOf: n } }, body)
const fromConfig = { bestOf: n }
evaluate('a number from a variable', { runs: fromConfig }, body)
