import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

const built = defineEnvironment('built', ({ plugin }) => ({
  sandbox: docker({ install: ['apt-get update'] }),
  plugins: [
    plugin.local('../plugins/built', { build: ['npm ci', 'npm run build'] }),
    plugin.git('github:acme/agent-plugins', {
      ref: 'v1.2.0',
      path: 'plugins/review',
      build: { run: 'pnpm install --frozen-lockfile', cwd: '.' },
    }),
  ],
}))

evaluate('built plugins', { environment: built }, async () => {})
evaluate('same plugins again', { environment: built }, async () => {})
