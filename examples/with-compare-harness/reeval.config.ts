import { defineConfig } from 'reeval'
import { profiles } from '../profiles.ts'

// No fake agent: the eval names its own real agents, which run in Docker.
export default defineConfig({
  include: ['*.eval.ts'],
  question: { model: 'anthropic/claude-sonnet-5' },
  // The real agents in ../profiles.ts; the eval's own harness list wins over theirs.
  profiles: { ...profiles },
})
