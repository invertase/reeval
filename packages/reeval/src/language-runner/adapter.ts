// One interface for every eval language: discovery, collection and attempt bodies.
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { loadEvalFile } from '../engine/loader.ts'
import { ownFile } from '../root.ts'
import { DART_RUNNER_HINT, resolveDartRunnerCommand } from './dart-runner.ts'
import { PYTHON_RUNNER_HINT, resolvePythonRunnerCommand } from './python-runner.ts'
import type { RunnerCommand } from './transport.ts'

type AdapterBase = {
  id: string
  extensions: readonly string[]
  includeGlobs: readonly string[]
  load(file: string, root: string): Promise<unknown>
}

/** Eval file loads in the worker process (TypeScript today). */
export type InProcessAdapter = AdapterBase & { remote: false; runnerCommand?: never }

/** Eval file loads in an SDK runner over the attempt protocol (Python today). */
export type RemoteAdapter = AdapterBase & {
  remote: true
  runnerCommand: (root: string) => RunnerCommand
  /** Appended when the runner can't start or stops before its hello: how to install the SDK. */
  setupHint: string
}

export type LanguageAdapter = InProcessAdapter | RemoteAdapter

export const TYPESCRIPT_ADAPTER: InProcessAdapter = {
  id: 'typescript',
  extensions: ['.eval.ts', '.eval.mts', '.eval.cts', '.eval.js', '.eval.mjs', '.eval.cjs'],
  includeGlobs: ['evals/**/*.eval.ts'],
  remote: false,
  load: (file, root) => loadEvalFile(file, root),
}

const repoPythonSdk = (): string | undefined => {
  const bundled = join(ownFile('..'), 'reeval-python')
  if (existsSync(join(bundled, 'pyproject.toml'))) return bundled
  return undefined
}

const PYTHON_ADAPTER: RemoteAdapter = {
  id: 'python',
  extensions: ['.eval.py'],
  includeGlobs: ['evals/**/*.eval.py'],
  remote: true,
  load: (file, root) => import('./remote.ts').then((m) => m.collectLanguageFile(file, root)),
  runnerCommand: (root) => resolvePythonRunnerCommand(root),
  setupHint: PYTHON_RUNNER_HINT,
}

const DART_ADAPTER: RemoteAdapter = {
  id: 'dart',
  extensions: ['.eval.dart'],
  includeGlobs: ['evals/**/*.eval.dart'],
  remote: true,
  load: (file, root) => import('./remote.ts').then((m) => m.collectLanguageFile(file, root)),
  runnerCommand: (root) => resolveDartRunnerCommand(root),
  setupHint: DART_RUNNER_HINT,
}

/** Every adapter; TypeScript is first and the in-process default. */
export const LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [
  TYPESCRIPT_ADAPTER,
  PYTHON_ADAPTER,
  DART_ADAPTER,
]

export function adapterForFile(file: string): LanguageAdapter {
  const match = LANGUAGE_ADAPTERS.find((a) => a.extensions.some((ext) => file.endsWith(ext)))
  return match ?? TYPESCRIPT_ADAPTER
}

export function defaultIncludeGlobs(): string[] {
  return LANGUAGE_ADAPTERS.flatMap((a) => [...a.includeGlobs])
}

export function runnerEnv(root: string, adapter: LanguageAdapter): NodeJS.ProcessEnv {
  if (adapter.id === 'dart') return { ...process.env, REEVAL_PROJECT_ROOT: resolve(root) }
  const sdk = process.env.REEVAL_PYTHON_SDK ?? repoPythonSdk()
  if (adapter.id !== 'python' || !sdk) return process.env
  const src = join(sdk, 'src')
  return {
    ...process.env,
    PYTHONPATH: [src, sdk, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    REEVAL_PROJECT_ROOT: resolve(root),
  }
}
