import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

/** The names Goose's Vertex AI route reads, set by the eval for its own use. */
export const VARS = {
  GCP_PROJECT_ID: 'eval-project',
  GCP_LOCATION: 'eval-location',
  GOOGLE_CLOUD_PROJECT: 'eval-cloud-project',
}

export const closed = defineEnvironment('closed', { sandbox, egress: 'deny-all', env: VARS })

export const prompt =
  "Run `env | grep -E '^(GCP_|GOOGLE_CLOUD_PROJECT=)' | sort > vars.txt; true` once with your " +
  'shell tool, then reply "done".'

/** The `NAME=value` lines the agent's shell saw. */
export const varsSeen = (text: string | null) => (text ?? '').split('\n').filter(Boolean)
