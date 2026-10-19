// How reeval starts the Python SDK runner for a project root (uv, venv, or system python3).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RunnerCommand } from './transport.ts'

export const REEVAL_PYTHON_MODULE = 'reeval_python'

const MODULE_ARGS = ['-m', REEVAL_PYTHON_MODULE] as const

let uvOnPath: boolean | undefined

export function uvAvailable(): boolean {
  if (uvOnPath !== undefined) return uvOnPath
  const result = spawnSync('uv', ['--version'], { encoding: 'utf8', stdio: 'pipe', windowsHide: true })
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

  return ['python3', ...MODULE_ARGS]
}
