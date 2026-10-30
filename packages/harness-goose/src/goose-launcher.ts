/**
 * The launcher's name, `executable` for `harness-acp`, which takes a bare name and runs
 * `<implementation>/home/.local/bin/<executable>`: the launcher goes beside Goose's own binary.
 */
export const GOOSE_LAUNCHER_EXECUTABLE = 'reeval-goose'

/** Where the launcher goes, under the sandbox home. */
export const GOOSE_LAUNCHER_PATH = `.ai-sdk-harness/.harness-bootstrap/goose/implementation/home/.local/bin/${GOOSE_LAUNCHER_EXECUTABLE}`

/**
 * The variable that holds Vertex AI's variables (project, location and credentials file), as a
 * JSON object the launcher sets in Goose's environment. One name on every provider keeps the
 * bootstrap, which lists the names, the same; Vertex AI's own variables, set or empty, would
 * replace the eval's values for the agent's commands.
 */
export const GOOSE_LAUNCHER_ENV = 'REEVAL_GOOSE_ENV'

/** Runs Goose with its arguments and the variables in {@link GOOSE_LAUNCHER_ENV} added. */
export const GOOSE_LAUNCHER = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const env = { ...process.env, ...JSON.parse(process.env.${GOOSE_LAUNCHER_ENV} || '{}') }
delete env.${GOOSE_LAUNCHER_ENV}
const child = spawn(join(here, 'goose'), process.argv.slice(2), { env, stdio: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
`
