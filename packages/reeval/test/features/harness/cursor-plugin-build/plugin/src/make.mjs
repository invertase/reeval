// The plugin's build: writes the subagent's body, which the source only has a placeholder for.
import { writeFileSync } from 'node:fs'

writeFileSync(
  'agents/reviewer.md',
  '---\nname: reviewer\ndescription: Reviews a change.\n---\n\nBUILT-41\n',
)
