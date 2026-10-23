import { defineEnvironment, evaluate } from 'reeval'

const fetcher = defineEnvironment('fetcher', ({ plugin }) => ({
  plugins: [plugin.local('../plugins/fetcher')],
}))

evaluate('npx under the default policy', { environment: fetcher }, async () => {})
evaluate(
  'npx with the registry allowed',
  { environment: fetcher, egress: { allow: ['registry.npmjs.org'] } },
  async () => {},
)
