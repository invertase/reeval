import { evaluate } from 'reeval'

evaluate(
  'ordinary env strings',
  { env: { NODE_ENV: 'production', LOG_LEVEL: 'debug' } },
  async () => {},
)
