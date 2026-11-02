import { defineEnvironment, evaluate, group } from 'reeval'

const listed = defineEnvironment('listed', ({ plugin }) => ({
  plugins: [
    plugin.marketplace('lint@github:acme/agent-plugins', { ref: 'v3', only: ['skills'] }),
    plugin.marketplace('format@npm:@acme/plugins@2.0.0'),
  ],
}))

group('marketplace plugins', { environments: listed }, () => {
  evaluate('entries read at the attempt', async () => {})
})
