import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HARNESS_CURSOR_VERSION } from '../src/image.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('package boundary', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
    )

  test('imports only Node built-ins, @ai-sdk harness packages and its own files', () => {
    for (const file of files(join(root, 'src'))) {
      const source = readFileSync(file, 'utf8')
      for (const [, spec] of source.matchAll(/from '([^']+)'/g)) {
        assert.match(
          spec ?? '',
          /^(node:|\.\.?\/|@ai-sdk\/harness(-cursor)?(\/|$))/,
          `${file} imports ${spec}`,
        )
      }
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies.evalsuite, undefined)
  })

  test('ships the Docker build context and pins the harness adapter', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.ok(pkg.files.includes('docker'))
    assert.match(readFileSync(join(root, 'docker/Dockerfile'), 'utf8'), /^FROM node:/m)
    assert.equal(pkg.dependencies['@ai-sdk/harness-cursor'], HARNESS_CURSOR_VERSION)
  })
})
