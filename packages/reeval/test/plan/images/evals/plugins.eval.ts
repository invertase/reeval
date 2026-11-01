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
    plugin.marketplace('lint@github:acme/agent-plugins', {
      ref: 'v3',
      build: { run: 'npm ci', cwd: '.' },
    }),
  ],
}))

evaluate('built plugins', { environments: built }, async () => {})
evaluate('same plugins again', { environments: built }, async () => {})
