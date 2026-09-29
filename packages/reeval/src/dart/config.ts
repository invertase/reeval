// `reeval.config.dart`: its `main` returns `defineConfig(...)`, which the runner sends as the same
// data a TypeScript config default-exports.
import { environmentFrom } from '../environment.ts'
import type { EnvironmentData, EsConfig } from '../types.ts'
import { prepareDartRunner } from './project.ts'
import { startDartRunner } from './runner.ts'

export async function loadDartConfig(
  root: string,
  configPath: string | undefined,
  context: { ci: boolean; command: string; profile?: string },
): Promise<EsConfig> {
  const command = await prepareDartRunner(root, configPath, (line) =>
    process.stderr.write(`${line}\n`),
  )
  // Every worker this process starts runs the same compiled runner.
  process.env.REEVAL_DART_RUNNER = JSON.stringify(command)
  const runner = await startDartRunner(command, root)
  try {
    runner.send({ t: 'config', context })
    const { config } = await runner.next('config')
    const environment = config.environment as unknown as EnvironmentData | undefined
    return environment ? { ...config, environment: environmentFrom(environment) } : config
  } finally {
    runner.close()
  }
}
