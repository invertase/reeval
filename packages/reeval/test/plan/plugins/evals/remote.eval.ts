import { defineEnvironment, evaluate, group } from 'reeval'

const fetched = defineEnvironment('fetched', ({ plugin }) => ({
  plugins: [
    plugin.git('github:acme/agent-plugins', { ref: 'v1.2.0', path: 'plugins/review' }),
    plugin.npm('@acme/review-plugin@1.2.0', { only: ['skills'] }),
  ],
}))
const pinned = fetched.extend('pinned', ({ plugin }) => ({
  plugins: [
    plugin.git('github:acme/agent-plugins', {
      ref: 'v1.3.0',
      path: 'plugins/review',
      build: { run: ['pnpm install --frozen-lockfile', 'pnpm build'], cwd: '.' },
    }),
  ],
}))

group('remote plugins', { environment: fetched }, () => {
  evaluate('git and npm read at the attempt', async () => {})
  evaluate('a child adds another', { environment: pinned }, async () => {})
})
