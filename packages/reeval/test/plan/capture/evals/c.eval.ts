import { evaluate } from 'reeval'

evaluate(
  'with defaults',
  {
    capture: {
      port: 5173,
      viewport: { width: 1280, height: 720 },
      timeout: '30s',
    },
  },
  async () => {},
)

evaluate('no cascade port', async () => {})

evaluate('browser off', { capture: { browser: false } }, async () => {})
