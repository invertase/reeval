// How reeval starts the Python SDK runner for a project root (uv, venv, or the system Python).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RunnerCommand } from './transport.ts'

export const REEVAL_PYTHON_MODULE = 'reeval_python'

const MODULE_ARGS = ['-m', REEVAL_PYTHON_MODULE] as const

let uvOnPath: boolean | undefined

export function uvAvailable(): boolean {
  if (uvOnPath !== undefined) return uvOnPath
  const result = spawnSync('uv', ['--version'], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  })
  uvOnPath = result.status === 0
  return uvOnPath
}

export function projectUsesUv(root: string): boolean {
  return existsSync(join(root, 'uv.lock')) || existsSync(join(root, 'pyproject.toml'))
}

function venvPython(root: string): string | undefined {
  const unix = join(root, '.venv', 'bin', 'python')
  if (existsSync(unix)) return unix
  const win = join(root, '.venv', 'Scripts', 'python.exe')
  if (existsSync(win)) return win
  return undefined
}

/** Runner argv for `startLanguageRunner`; `REEVAL_PYTHON` overrides everything. */
export function resolvePythonRunnerCommand(root: string): RunnerCommand {
  const override = process.env.REEVAL_PYTHON?.trim()
  if (override) return [override, ...MODULE_ARGS]

  if (projectUsesUv(root) && uvAvailable()) {
    return ['uv', 'run', '--project', root, 'python', ...MODULE_ARGS]
  }

  const venv = venvPython(root)
  if (venv) return [venv, ...MODULE_ARGS]

  // Windows' python3 is usually the Microsoft Store stub, which opens the Store instead of running.
  return [process.platform === 'win32' ? 'python' : 'python3', ...MODULE_ARGS]
}

/** What a failed Python runner start tells the user, after the runner's own output. */
export const PYTHON_RUNNER_HINT = [
  `reeval runs *.eval.py with the ${REEVAL_PYTHON_MODULE} module from the project's Python:`,
  '`uv run` when the project has a pyproject.toml and uv is on PATH, else .venv, else',
  'python3 (REEVAL_PYTHON names another interpreter). Install the reeval-python release made',
  'for this reeval there, e.g. `uv add reeval-python`.',
].join(' ')
