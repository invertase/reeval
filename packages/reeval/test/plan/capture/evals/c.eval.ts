import { evaluate } from 'reeval'

evaluate(
  'with defaults',
  {
    capture: {
      viewport: { width: 1280, height: 720 },
      timeout: '30s',
    },
  },
  async () => {},
)

evaluate('no camera defaults', async () => {})

evaluate('browser off', { capture: { browser: false } }, async () => {})

evaluate('full page', { capture: { viewport: 'full-page' } }, async () => {})
