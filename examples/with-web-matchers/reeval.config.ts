import { defineConfig } from 'reeval'
import { profiles } from '../profiles.ts'

export default defineConfig({
  include: ['*.eval.ts'],
  // The fake agent makes no web calls, so this example runs Claude Code unless --profile names
  // another agent.
  defaultProfile: { local: 'claude-code', ci: 'claude-code' },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
