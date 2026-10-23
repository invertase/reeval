// Runs the Dart SDK's tests, the conformance goldens through its runner among them.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_EGRESS_ALLOW } from '../src/egress.ts'
import { MATCHERS } from '../src/matchers.ts'
import { PACKAGE_VERSION } from '../src/root.ts'
import { dartSdk, prepareDartSdk } from './support/dart-fixture.ts'

const dart = (): boolean => spawnSync('dart', ['--version'], { stdio: 'pipe' }).status === 0

test('Dart SDK tests and conformance goldens', () => {
  if (!dart()) assert.fail('dart is required for the Dart SDK tier (https://dart.dev/get-dart)')
  prepareDartSdk()
  execFileSync('dart', ['analyze', '--fatal-infos'], { cwd: dartSdk, stdio: 'inherit' })
  execFileSync('dart', ['format', '--output=none', '--set-exit-if-changed', '.'], {
    cwd: dartSdk,
    stdio: 'inherit',
  })
  execFileSync('dart', ['test', '--reporter=failures-only'], { cwd: dartSdk, stdio: 'inherit' })
})

test("the Dart SDK's defaultEgressAllow is reeval's", () => {
  const source = readFileSync(join(dartSdk, 'lib/src/options.dart'), 'utf8')
  const list = /const defaultEgressAllow = \[([^\]]*)\]/.exec(source)?.[1]
  assert.ok(list, 'defaultEgressAllow is a list literal in options.dart')
  const hosts = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(hosts, [...DEFAULT_EGRESS_ALLOW])
})

test("the Dart SDK has a matcher for each of reeval's", () => {
  const source = readFileSync(join(dartSdk, 'lib/src/expect.dart'), 'utf8')
  const named = new Set(
    [...source.matchAll(/(?:reevalMatcher|ReevalMatcher\._)\(\s*'(\w+)'/g)].map((m) => m[1]),
  )
  assert.deepEqual([...named].sort(), Object.keys(MATCHERS).sort())
})

test("the Dart SDK's version is reeval's, which it releases with", () => {
  const pubspec = readFileSync(join(dartSdk, 'pubspec.yaml'), 'utf8')
  const version = readFileSync(join(dartSdk, 'lib/src/version.dart'), 'utf8')
  assert.equal(/^version: (\S+)/m.exec(pubspec)?.[1], PACKAGE_VERSION)
  assert.equal(/packageVersion = '([^']+)'/.exec(version)?.[1], PACKAGE_VERSION)
})
