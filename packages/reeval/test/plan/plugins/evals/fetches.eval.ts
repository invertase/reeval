import { defineEnvironment, evaluate } from 'reeval'

const fetcher = defineEnvironment('fetcher', ({ plugin }) => ({
  plugins: [plugin.local('../plugins/fetcher')],
}))

evaluate('npx under the default policy', { environments: fetcher }, async () => {})
evaluate(
  'npx with the registry allowed',
  { environments: fetcher, egress: { allow: ['registry.npmjs.org'] } },
  async () => {},
)
