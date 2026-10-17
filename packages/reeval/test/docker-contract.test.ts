import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { z } from 'zod'
import {
  checkDockerOptions,
  dockerSandboxProblem,
  dockerSandboxSchema,
} from '../src/contract/docker.ts'
import { checkOptions } from '../src/options.ts'

const declaration = JSON.parse(
  readFileSync(new URL('../schema/plan/declaration.schema.json', import.meta.url), 'utf8'),
)

test('the declaration schema carries Zod’s DockerSandboxDescriptor: descriptions, patterns, bounds', () => {
  const docker = declaration.$defs.DockerSandboxDescriptor
  assert.equal(docker.additionalProperties, false)
  assert.equal(docker.properties.memory.description.startsWith("The container's memory"), true)
  assert.deepEqual(docker.properties.pids, {
    description: 'Processes and threads at once. Default 1024.',
    type: 'integer',
    exclusiveMinimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(docker.properties.install.items.$ref, '#/$defs/InstallStep')
  const timeout = declaration.$defs.InstallStep.anyOf[1].properties.timeout
  assert.equal(timeout.anyOf[1].pattern, '^(?=.*[1-9])\\d+(\\.\\d+)?(ms|s|m|h)$')
})

test('every field description matches its TSDoc on DockerSandboxDescriptor', () => {
  const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')
  const body = /export type DockerSandboxDescriptor = \{\n([\s\S]*?)\n\}/.exec(types)?.[1] ?? ''
  const docs = new Map<string, string>()
  for (const [, doc, key] of body.matchAll(/\/\*\*([\s\S]*?)\*\/\n\s+(\w+)\??:/g)) {
    const text = (doc as string)
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .filter(Boolean)
      .join(' ')
    docs.set(key as string, text)
  }
  const shape: Record<string, z.ZodType> = dockerSandboxSchema.shape
  for (const [key, field] of Object.entries(shape)) {
    if (key === 'kind') continue
    assert.equal(field.description, docs.get(key), `docker.${key}`)
  }
})

test('a Docker descriptor from data gets the same sentences as docker()', () => {
  const cases: Array<[unknown, string]> = [
    [
      { kind: 'docker', memorySwap: '8g' },
      'Unknown docker() option "memorySwap". Did you mean "swap"?',
    ],
    [
      { kind: 'docker', memory: '4GB' },
      `docker({ memory }) takes a size such as '4g' or '512m', or bytes (got "4GB")`,
    ],
    [
      { kind: 'docker', swap: -1 },
      `docker({ swap }) takes a size such as '2g' or '512m', bytes, or 0 for none (got -1)`,
    ],
    [
      { kind: 'docker', image: 'a', from: 'b' },
      'docker() takes one base image, but got image and from. Use image (has the harness), from (a toolchain image reeval bakes the harness onto) or dockerfile.',
    ],
    [
      { kind: 'docker', install: [{ run: 'ls', timeout: '0s' }] },
      'docker({ install }) command "ls": Invalid duration "0s". A duration is more than zero: use e.g. "90s" or "15m".',
    ],
  ]
  for (const [value, message] of cases) assert.equal(dockerSandboxProblem(value), message)
  assert.equal(dockerSandboxProblem({ kind: 'docker', memory: '4g', install: ['ls'] }), null)
  assert.throws(
    () => checkOptions({ sandbox: { kind: 'docker', memswap: 1 } }, 'evals/a.declaration.json'),
    {
      message:
        'sandbox in evals/a.declaration.json: Unknown docker() option "memswap". Did you mean "swap"?',
    },
  )
})

test('an unknown key is reported before a bad value, as docker() always has', () => {
  assert.throws(() => checkDockerOptions({ cpus: 0, mem: '1g' }), {
    message: 'Unknown docker() option "mem". Did you mean "memory"?',
  })
  assert.throws(() => checkDockerOptions({ pids: 0, root: 'yes' }), {
    message: 'docker({ root }) is true or false (got "yes")',
  })
})
