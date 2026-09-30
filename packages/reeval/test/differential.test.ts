import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { normaliseRecord, normaliseText } from './support/differential.ts'

describe('differential normalisation', () => {
  test('a release bump is the same banner, version line and record', () => {
    const banner = (version: string) =>
      `reeval ${version} · 1 eval file · harness fake · sandbox fake`
    const padded = (version: string) => `  reeval        ${version} · node v22.14.0 · linux/x64`
    const table = (version: string) => `| reeval | ${version} · node v22.14.0 · linux/x64 |`
    assert.equal(normaliseText(banner('0.0.1'), []), normaliseText(banner('0.1.0'), []))
    assert.equal(normaliseText(padded('0.0.1'), []), normaliseText(padded('0.1.0'), []))
    assert.equal(normaliseText(table('0.0.1'), []), normaliseText(table('0.1.0'), []))
    assert.equal(normaliseText('0.0.1\n', []), normaliseText('0.1.0\n', []))
    assert.equal(
      normaliseText('reeval 0.1.0 — eval runner for coding agents\n', []),
      normaliseText('reeval 0.2.0 — eval runner for coding agents\n', []),
    )
    const record = (es: string) =>
      normaliseRecord({ stack: { es, os: 'linux' }, status: 'complete' }, [])
    assert.deepEqual(record('0.0.1'), record('0.1.0'))
    assert.deepEqual(record('0.1.0'), { stack: { os: 'linux' }, status: 'complete' })
  })

  test("the runtime's version is the machine's, like Node's", () => {
    const shown = (version: string) =>
      `"node": "${version}",\n"runtime": {\n  "name": "node",\n  "version": "${version}"\n}`
    assert.equal(normaliseText(shown('22.14.0'), []), normaliseText(shown('24.1.0'), []))
    const record = (version: string) =>
      normaliseRecord({ stack: { node: version, runtime: { name: 'node', version } } }, [])
    assert.deepEqual(record('22.14.0'), { stack: { runtime: { name: 'node' } } })
  })

  test('judge versions and fingerprints that follow the package version drop out', () => {
    const before = [
      '  ✓ → ✓  changed (not comparable)  evals/greet.es.ts › writes greet.js: evals/greet.es.ts changed, harness config changed',
      '',
    ].join('\n')
    const after = [
      '  ✓ → ✓  changed (not comparable)  evals/greet.es.ts › writes greet.js: evals/greet.es.ts changed, harness config changed, judge changed',
      'stack changed: judge version 0e2a4839495b → c1458fecef5d',
      '',
    ].join('\n')
    assert.equal(normaliseText(before, []), normaliseText(after, []))
    const shown = (hash: string, fp: string) =>
      `"judgeVersion": "${hash}"\n"judge": "${fp}"\n"fingerprint": "${'a'.repeat(64)}"\n`
    assert.equal(
      normaliseText(shown('6334f0ba15cf', '9'.repeat(64)), []),
      normaliseText(shown('22d1f60c07c1', '8'.repeat(64)), []),
    )
  })

  test('a real difference in the banner still counts', () => {
    assert.notEqual(
      normaliseText('reeval 0.1.0 · 1 eval file', []),
      normaliseText('reeval 0.1.0 · 2 eval files', []),
    )
  })
})
