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

/** The names the report looks for: the eval's, and the credentials file Vertex AI's route sets. */
const REPORTED = [...Object.keys(VARS), 'GOOGLE_APPLICATION_CREDENTIALS'].sort()

/**
 * Writes each of {@link REPORTED} that is set, even empty, to vars.txt, from a script: a prompt
 * that names them reads as credential harvesting to Gemini, which then refuses to run it.
 */
const REPORT = `for name in ${REPORTED.join(' ')}; do
  printenv "$name" > /dev/null && echo "$name=$(printenv "$name")"
done > vars.txt
`

export const closed = defineEnvironment('closed', {
  sandbox,
  egress: 'deny-all',
  env: VARS,
  files: { 'report.sh': REPORT },
})

export const prompt = 'Run `sh report.sh` once with your shell tool, then reply "done".'

/** The `NAME=value` lines the agent's shell saw. */
export const varsSeen = (text: string | null) => (text ?? '').split('\n').filter(Boolean)
