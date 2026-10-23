// How reeval starts the Dart SDK runner for a project root: `dart run reeval:runner`, JIT, against
// the package:reeval in the project's lockfile.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ownFile } from '../root.ts'
import type { RunnerCommand } from './transport.ts'

const repoDartSdk = (): string | undefined => {
  const bundled = join(ownFile('..'), 'reeval-dart')
  return existsSync(join(bundled, 'pubspec.yaml')) ? bundled : undefined
}

const resolved = (dir: string): boolean =>
  existsSync(join(dir, '.dart_tool', 'package_config.json'))

/**
 * Runner argv for `startLanguageRunner`. `REEVAL_DART` names the `dart` to use. A project with no
 * pub packages of its own (this repository's fixtures) runs the SDK at `REEVAL_DART_SDK`, or the
 * monorepo's, with that SDK's packages.
 */
export function resolveDartRunnerCommand(root: string): RunnerCommand {
  const dart = process.env.REEVAL_DART?.trim() || 'dart'
  const sdk = process.env.REEVAL_DART_SDK?.trim() || (resolved(root) ? undefined : repoDartSdk())
  if (sdk && resolved(sdk)) {
    return [
      dart,
      '--enable-asserts',
      `--packages=${join(sdk, '.dart_tool', 'package_config.json')}`,
      join(sdk, 'bin', 'runner.dart'),
    ]
  }
  return [dart, 'run', '--enable-asserts', 'reeval:runner']
}

/** What a failed Dart runner start tells the user, after the runner's own output. */
export const DART_RUNNER_HINT = [
  "reeval runs *.eval.dart with `dart run reeval:runner` from the project's pub packages",
  '(REEVAL_DART names another dart). Add the package:reeval release made for this reeval,',
  'e.g. `dart pub add reeval`, then `dart pub get`.',
].join(' ')
