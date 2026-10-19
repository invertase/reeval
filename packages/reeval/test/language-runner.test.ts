import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  projectUsesUv,
  resolvePythonRunnerCommand,
  REEVAL_PYTHON_MODULE,
} from '../src/language-runner/python-runner.ts'

test('resolvePythonRunnerCommand prefers REEVAL_PYTHON', () => {
  const prev = process.env.REEVAL_PYTHON
  process.env.REEVAL_PYTHON = '/custom/python'
  try {
    assert.deepEqual(resolvePythonRunnerCommand('/any'), ['/custom/python', '-m', REEVAL_PYTHON_MODULE])
  } finally {
    if (prev === undefined) delete process.env.REEVAL_PYTHON
    else process.env.REEVAL_PYTHON = prev
  }
})

test('resolvePythonRunnerCommand uses .venv python when present', () => {
  const prev = process.env.REEVAL_PYTHON
  delete process.env.REEVAL_PYTHON
  const root = mkdtempSync(join(tmpdir(), 'reeval-py-'))
  const venvBin = join(root, '.venv', 'bin')
  mkdirSync(venvBin, { recursive: true })
  writeFileSync(join(venvBin, 'python'), '#!/bin/sh\n', { mode: 0o755 })
  try {
    const cmd = resolvePythonRunnerCommand(root)
    assert.equal(cmd[0], join(root, '.venv', 'bin', 'python'))
    assert.deepEqual(cmd.slice(1), ['-m', REEVAL_PYTHON_MODULE])
  } finally {
    if (prev === undefined) delete process.env.REEVAL_PYTHON
    else process.env.REEVAL_PYTHON = prev
  }
})

test('projectUsesUv is true when pyproject.toml or uv.lock exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'reeval-py-'))
  assert.equal(projectUsesUv(root), false)
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "x"\n')
  assert.equal(projectUsesUv(root), true)
})
