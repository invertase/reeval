import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

const skill = (name: string, body: string) =>
  `mkdir -p .agents/skills/${name} && printf -- '---\\nname: ${name}\\ndescription: ${body}\\n---\\n\\n${body}\\n' > .agents/skills/${name}/SKILL.md`

// Not the environment's `skills`: a setup step installs them, as a package manager's skill
// installer (`dart run skills get`) would.
export const installed = defineEnvironment('installed', {
  sandbox,
  setup: [
    { run: skill('house-greeting', 'Greet people with Ahoy.') },
    { run: skill('house-farewell', 'Say goodbye with Fair winds.') },
  ],
})
