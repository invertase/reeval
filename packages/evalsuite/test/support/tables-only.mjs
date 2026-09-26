// `--import` this to load a test file for its tables without running it: `node:test` resolves to
// a module whose test functions do nothing. The feature matrix reads features.test.ts and
// plan.test.ts this way, so the tables stay where the tests are.
import { register } from 'node:module'

const stub = `
const nothing = () => {}
export const describe = nothing, suite = nothing, test = nothing, it = nothing
export const before = nothing, after = nothing, beforeEach = nothing, afterEach = nothing
export const mock = {}, run = nothing
export default nothing
`
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === 'node:test' || specifier === 'test')
    return { url: 'data:text/javascript,${encodeURIComponent(stub)}', shortCircuit: true }
  return next(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(hooks)}`)
