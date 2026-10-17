// Every refusal of the SDK-facing contract, by segment: an input and the call that checks it.
// test/refusals.test.ts runs each and holds its exact message (or `null`, accepted) to
// test/refusals/<segment>.json, so a change of wording, or of what's accepted, shows as a diff.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../../src/config.ts'
import { defineEnvironment } from '../../src/environment.ts'
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fakeHarness,
  goose,
  opencode,
  pi,
} from '../../src/harness.ts'
import { checkHarnesses, checkOptions } from '../../src/options.ts'
import { docker } from '../../src/sandbox.ts'
import type { EnvironmentHelpers } from '../../src/types.ts'

export type Case = [name: string, run: () => unknown]

const WHERE = 'evals/a.eval.ts › e'
const options = (o: unknown) => () => checkOptions(o as object, WHERE)
const harnesses =
  (...list: unknown[]) =>
  () =>
    checkHarnesses(list, WHERE)
const config = (c: unknown) => () => resolveConfig(c as never, '/project', 'reeval.config.ts')
const env = (spec: unknown) => () => defineEnvironment('e', spec as never)
const helpers = (use: (h: EnvironmentHelpers) => unknown) => () =>
  defineEnvironment('e', (h) => ({ files: { 'a.txt': 'a' }, ...(use(h) as object) }))
const any =
  // biome-ignore lint/suspicious/noExplicitAny: refusals are about values the types refuse
    (f: (...args: any[]) => unknown, ...args: unknown[]) =>
    () =>
      f(...args)

/** A directory with one file and an empty subdirectory, for `directory()`, and a Dockerfile. */
export const DIR = mkdtempSync(join(tmpdir(), 'reeval-refusals-'))
writeFileSync(join(DIR, 'a.txt'), 'a')
writeFileSync(join(DIR, 'Dockerfile'), 'FROM debian:bookworm-slim\n')
mkdirSync(join(DIR, 'empty'))

const e1 = defineEnvironment('one', {})
const e2 = defineEnvironment('two', {})
const envData = (spec: unknown) => ({
  kind: 'environment',
  name: 'x',
  layers: [{ name: 'x', spec }],
})

export const CASES: Record<string, Case[]> = {
  shared: [
    ['duration: setup timeout soon', env({ setup: [{ run: 'ls', timeout: 'soon' }] })],
    ['duration: setup timeout 0', env({ setup: [{ run: 'ls', timeout: 0 }] })],
    ['duration: setup timeout 0s', env({ setup: [{ run: 'ls', timeout: '0s' }] })],
    ['duration: setup timeout -5s', env({ setup: [{ run: 'ls', timeout: '-5s' }] })],
    ['duration: setup timeout 1.5m', env({ setup: [{ run: 'ls', timeout: '1.5m' }] })],
    [
      'duration: harness startTimeout soon',
      harnesses(fakeHarness({ startTimeout: 'soon' as never })),
    ],
    ['duration: harness startTimeout 2m', harnesses(fakeHarness({ startTimeout: '2m' }))],
  ],
  docker: [
    ['not an object', any(docker, 'x')],
    ['an array', any(docker, [])],
    ['two bases', any(docker, { image: 'x:1', dockerfile: join(DIR, 'Dockerfile') })],
    ['image and from', any(docker, { image: 'x:1', from: 'python:3.12-slim' })],
    ['three bases', any(docker, { image: 'x', from: 'y', dockerfile: join(DIR, 'Dockerfile') })],
    [
      'install with a dockerfile',
      any(docker, { dockerfile: join(DIR, 'Dockerfile'), install: ['x'] }),
    ],
    ['a missing dockerfile', any(docker, { dockerfile: join(DIR, 'nope/Dockerfile') })],
    ['a dockerfile that is a number', any(docker, { dockerfile: 3 })],
    ['an empty dockerfile', any(docker, { dockerfile: ' ' })],
    ['a dockerfile URL', any(docker, { dockerfile: new URL(`file://${join(DIR, 'Dockerfile')}`) })],
    ['an empty install', any(docker, { install: [] })],
    ['install not a list', any(docker, { install: 'apt-get install jq' })],
    ['an install command that is not a command', any(docker, { install: [{ command: 'x' }] })],
    ['an empty install command', any(docker, { install: ['  '] })],
    ['an install command with an extra key', any(docker, { install: [{ run: 'x', cwd: '/' }] })],
    ['a bad install timeout', any(docker, { install: [{ run: 'x', timeout: 'soon' }] })],
    ['a zero install timeout', any(docker, { install: [{ run: 'ls', timeout: 0 }] })],
    ['a negative install timeout', any(docker, { install: [{ run: 'ls', timeout: '-5s' }] })],
    ['steps instead of install', any(docker, { steps: ['x'] })],
    ['user instead of root', any(docker, { user: 'root' })],
    ['an unknown key without a hint', any(docker, { colour: 'blue' })],
    ['root that is not a boolean', any(docker, { root: 'yes' })],
    ['a capability that is not a name', any(docker, { capabilities: 'NET_RAW' })],
    ['a lower-case capability', any(docker, { capabilities: ['net_raw'] })],
    ['a memory size docker does not take', any(docker, { memory: '4GB' })],
    ['a fractional memory in bytes', any(docker, { memory: 1.5 })],
    ['memorySwap instead of swap', any(docker, { memorySwap: '8g' })],
    ['memswap instead of swap', any(docker, { memswap: '8g' })],
    ['a negative swap', any(docker, { swap: -1 })],
    ['zero CPUs', any(docker, { cpus: 0 })],
    ['infinite CPUs', any(docker, { cpus: Number.POSITIVE_INFINITY })],
    ['a fractional process limit', any(docker, { pids: 10.5 })],
    ['an empty id', any(docker, { id: '' })],
    ['an image that is not a string', any(docker, { image: 3 })],
    ['an empty from', any(docker, { from: ' ' })],
    ['secrets on the sandbox', any(docker, { env: {} })],
    ['environment on the sandbox', any(docker, { environment: {} })],
    ['an unknown key and a bad value', any(docker, { cpus: 0, mem: '1g' })],
    ['two bad values', any(docker, { pids: 0, root: 'yes' })],
    ['a good one', any(docker, { from: 'node:24', memory: '4g', swap: 0, install: ['ls'] })],
    ['data: not docker() or fakeSandbox()', options({ sandbox: { kind: 'vm' } })],
    ['data: maxConcurrent 0', options({ sandbox: { kind: 'docker', maxConcurrent: 0 } })],
    ['data: a typo', options({ sandbox: { kind: 'docker', memswap: '8g' } })],
    ['data: a bad memory', options({ sandbox: { kind: 'docker', memory: '4GB' } })],
    ['data: two bases', options({ sandbox: { kind: 'docker', image: 'a', from: 'b' } })],
    ['data: a bad install step', options({ sandbox: { kind: 'docker', install: [{ run: '' }] } })],
    ['data: in an environment', env({ sandbox: { kind: 'docker', memswap: '8g' } })],
    ['data: fake with a typo', options({ sandbox: { kind: 'fake', dri: '/tmp' } })],
  ],
  harness: [
    ['cursor without a model', any(cursor, {})],
    ['cursor with an empty model', any(cursor, { model: '' })],
    ['cursor with no options', any(cursor)],
    ['cursor params not strings', any(cursor, { model: 'm', params: { fast: false } })],
    ['cursor params not an object', any(cursor, { model: 'm', params: 'fast' })],
    ['cursor effort empty', any(cursor, { model: 'm', effort: ' ' })],
    ['cursor effort a number', any(cursor, { model: 'm', effort: 3 })],
    ['cursor with a typo', any(cursor, { model: 'm', modle: 'x' })],
    [
      'cursor good',
      any(cursor, { model: 'composer-2.5', params: { fast: 'false' }, effort: 'high' }),
    ],
    ['claudeCode without a model', any(claudeCode, {})],
    ['claudeCode with a bad effort', any(claudeCode, { model: 'sonnet', effort: 'huge' })],
    ['claudeCode with an empty effort', any(claudeCode, { model: 'sonnet', effort: '' })],
    ['claudeCode with a typo', any(claudeCode, { model: 'sonnet', efort: 'high' })],
    ['antigravity without a model', any(antigravity, {})],
    ['antigravity effort a number', any(antigravity, { model: 'g', effort: 1 })],
    ['opencode without a model', any(opencode, {})],
    ['opencode without a provider', any(opencode, { model: 'gemini-3.8-flash' })],
    ['opencode with an unknown provider', any(opencode, { model: 'nope/model' })],
    ['opencode good', any(opencode, { model: 'google/gemini-3.8-flash' })],
    ['goose with a provider', any(goose, { model: 'google/gemini-3.8-flash' })],
    ['goose without a model', any(goose, {})],
    ['pi with a provider', any(pi, { model: 'google/gemini-3.8-flash' })],
    ['pi effort empty', any(pi, { model: 'gemini-3.8-flash', effort: '' })],
    ['codex with a provider', any(codex, { model: 'openai/gpt-5.6-luna' })],
    ['codex without a model', any(codex, {})],
    ['fakeHarness script not a list', any(fakeHarness, { script: 'x' })],
    ['fakeHarness script a flat list', any(fakeHarness, { script: [{ exec: 'ls' }] })],
    ['fakeHarness script step unknown', any(fakeHarness, { script: [[{ run: 'ls' }]] })],
    [
      'fakeHarness script step two keys',
      any(fakeHarness, { script: [[{ exec: 'ls', reply: 'x' }]] }),
    ],
    ['fakeHarness script write not strings', any(fakeHarness, { script: [[{ write: { a: 1 } }]] })],
    ['fakeHarness script mcp without a tool', any(fakeHarness, { script: [[{ mcp: 'server' }]] })],
    ['fakeHarness script exec not a string', any(fakeHarness, { script: [[{ exec: 1 }]] })],
    ['fakeHarness layout unknown', any(fakeHarness, { layout: 'vim' })],
    ['fakeHarness effort empty', any(fakeHarness, { effort: '' })],
    ['fakeHarness with a typo', any(fakeHarness, { txt: 'x' })],
    ['fakeHarness text a number', any(fakeHarness, { text: 3 })],
    ['fakeHarness files not strings', any(fakeHarness, { files: { 'a.txt': 1 } })],
    [
      'fakeHarness a tool with an extra key',
      any(fakeHarness, { tools: [{ tool: 't', input: 1, output: 2, okay: true }] }),
    ],
    ['cursor with an empty id', any(cursor, { model: 'm', id: '' })],
    ['codex with a typo far from any option', any(codex, { model: 'gpt', colour: 'red' })],
    [
      'fakeHarness good',
      any(fakeHarness, { script: [[{ exec: 'ls' }, { mcp: 's/t' }]], layout: 'pi' }),
    ],
    ['data: not a harness', harnesses({ kind: 'vim' })],
    ['data: a list item that is a string', harnesses('cursor')],
    ['data: maxConcurrent 0', harnesses({ kind: 'fake', maxConcurrent: 0 })],
    ['data: maxConcurrent 1.5', harnesses({ kind: 'cursor', model: 'm', maxConcurrent: 1.5 })],
    ['data: startTimeout bad', harnesses({ kind: 'cursor', model: 'm', startTimeout: 'soon' })],
    ['data: opencode without a provider', harnesses({ kind: 'opencode', model: 'gemini' })],
    ['data: cursor without a model', harnesses({ kind: 'cursor' })],
    ['data: cursor with a typo', harnesses({ kind: 'cursor', model: 'm', modle: 'x' })],
    [
      'data: claude-code with a bad effort',
      harnesses({ kind: 'claude-code', model: 'm', effort: 'huge' }),
    ],
    ['data: goose with a provider', harnesses({ kind: 'goose', model: 'google/g' })],
    ['data: fake with a bad layout', harnesses({ kind: 'fake', layout: 'vim' })],
    ['data: fake with a bad script', harnesses({ kind: 'fake', script: [{ exec: 'ls' }] })],
    ['data: good', harnesses({ kind: 'cursor', model: 'm' }, { kind: 'fake', id: 'f' })],
  ],
  judge: [
    ['threshold above 1', options({ judge: { threshold: 2 } })],
    ['threshold a string', options({ judge: { threshold: '0.5' } })],
    ['maxConcurrent 0', options({ judge: { maxConcurrent: 0 } })],
    ['include not a list', options({ judge: { include: 'src/' } })],
    ['include with an empty pattern', options({ judge: { include: ['src/', ' '] } })],
    ['files not a list', options({ judge: { files: 'a.ts' } })],
    ['a typo', options({ judge: { treshold: 0.5 } })],
    ['good', options({ judge: { threshold: 0.5, include: ['src/'], maxConcurrent: 2 } })],
    ['config: model without a provider', config({ judge: { model: 'jev' } })],
    ['config: model an object', config({ judge: { model: { specificationVersion: 'v2' } } })],
    [
      'config: fake judge score function',
      config({ judge: { model: { kind: 'fake-judge', score: () => 1 } } }),
    ],
    ['config: threshold above 1', config({ judge: { threshold: 1.5 } })],
    ['config: files with an empty path', config({ judge: { files: [''] } })],
    ['config: good', config({ judge: { model: 'google/gemini-3.8-flash', threshold: 0.7 } })],
  ],
  compare: [
    ['a list', options({ compare: [e1, e2] })],
    ['no variants', options({ compare: { baseline: e1 } })],
    ['variants not a list', options({ compare: { variants: e1 } })],
    ['empty variants', options({ compare: { variants: [] } })],
    ['a variant that is not an environment', options({ compare: { variants: ['two'] } })],
    [
      'a baseline that is not an environment',
      options({ compare: { baseline: 'one', variants: [e2] } }),
    ],
    ['question instead of questions', options({ compare: { variants: [e2], question: 'Which?' } })],
    ['cut instead of across', options({ compare: { variants: [e2], cut: 'harness' } })],
    ['an unknown key', options({ compare: { variants: [e2], arms: [] } })],
    ['gate unknown', options({ compare: { variants: [e2], gate: 'some' } })],
    ['minLift above 1', options({ compare: { variants: [e2], minLift: 2 } })],
    ['minLift a string', options({ compare: { variants: [e2], minLift: '0.1' } })],
    ['harness not a list', options({ compare: { variants: [e2], harness: 'cursor' } })],
    ['questions not a list', options({ compare: { variants: [e2], questions: 'Which?' } })],
    ['questions empty', options({ compare: { variants: [e2], questions: [] } })],
    ['a question that is empty', options({ compare: { variants: [e2], questions: [' '] } })],
    ['a question that is a number', options({ compare: { variants: [e2], questions: [3] } })],
    [
      'a question with an unknown key',
      options({ compare: { variants: [e2], questions: [{ question: 'Q', by: 'm' }] } }),
    ],
    [
      'a question with cuts',
      options({ compare: { variants: [e2], questions: [{ question: 'Q', cuts: 'x' }] } }),
    ],
    [
      'a question without its text',
      options({ compare: { variants: [e2], questions: [{ model: 'google/g' }] } }),
    ],
    [
      'a question model without a provider',
      options({ compare: { variants: [e2], questions: [{ question: 'Q', model: 'g' }] } }),
    ],
    [
      'a question model that is an evaluation model',
      options({
        compare: {
          variants: [e2],
          questions: [{ question: 'Q', model: 'typesafe-ai/jev-1.13.0' }],
        },
      }),
    ],
    [
      'a question across unknown',
      options({ compare: { variants: [e2], questions: [{ question: 'Q', across: 'cell' }] } }),
    ],
    [
      'a question twice',
      options({ compare: { variants: [e2], questions: ['Q', { question: 'Q' }] } }),
    ],
    ['across unknown', options({ compare: { variants: [e2], across: 'cell' } })],
    ['across an empty list', options({ compare: { variants: [e2], across: [] } })],
    ['across twice', options({ compare: { variants: [e2], across: ['harness', 'harness'] } })],
    ['compare false', options({ compare: false })],
    [
      'harness with a bad descriptor',
      options({ compare: { variants: [e2], harness: [{ kind: 'cursor', modle: 'm' }] } }),
    ],
    ['harness with a number', options({ compare: { variants: [e2], harness: [3] } })],
    [
      'environment beside baseline',
      options({ environment: e1, compare: { baseline: e1, variants: [e2] } }),
    ],
    [
      'good',
      options({
        compare: {
          baseline: e1,
          variants: [e2],
          gate: 'all',
          minLift: 0.1,
          harness: ['fake'],
          questions: ['Q', { question: 'R', model: 'google/g', across: 'harness' }],
          across: ['environment'],
        },
      }),
    ],
    [
      'data: a variant with a bad spec',
      options({ compare: { variants: [envData({ setpu: [] })] } }),
    ],
  ],
  plain: [
    ['gate a number', options({ gate: 0.8 })],
    ['gate passRate 0', options({ gate: { passRate: 0 } })],
    ['gate passRate above 1', options({ gate: { passRate: 1.2 } })],
    ['gate with an extra key', options({ gate: { passRate: 0.5, min: 1 } })],
    ['gate good', options({ gate: { passRate: 0.8 } })],
    ['egress a list', options({ egress: ['api.example.com'] })],
    ['egress a string', options({ egress: 'none' })],
    ['egress deny key', options({ egress: { deny: ['x.com'] } })],
    ['egress hosts key', options({ egress: { hosts: ['x.com'] } })],
    ['egress an unknown key', options({ egress: { allow: [], via: 'proxy' } })],
    ['egress allow not a list', options({ egress: { allow: 'x.com' } })],
    ['egress a URL', options({ egress: { allow: ['https://x.com/a'] } })],
    ['egress a port', options({ egress: { allow: ['x.com:443'] } })],
    ['egress a wildcard TLD', options({ egress: { allow: ['*.com'] } })],
    ['egress a wildcard address', options({ egress: { allow: ['*.1.2.3'] } })],
    ['egress not a host', options({ egress: { allow: ['a b'] } })],
    [
      'egress good',
      options({ egress: { allow: ['api.example.com', '*.example.org', '1.2.3.4'] } }),
    ],
    ['egress in an environment', env({ egress: ['x.com'] })],
    ['env not an object', options({ env: 'A=1' })],
    ['env a bad name', options({ env: { 'A-B': '1' } })],
    ['env a number', options({ env: { A: 1 } })],
    ['env a literal secret', options({ env: { API_KEY: 'sk-123' } })],
    ['env a secret', options({ env: { API_KEY: { kind: 'secret' } } })],
    ['env in an environment', env({ env: { A: 1 } })],
    [
      'secret to unknown',
      helpers(({ secret }) => ({ env: { A_KEY: secret({ to: 'host' as never }) } })),
    ],
    ['secret hosts empty', helpers(({ secret }) => ({ env: { A_KEY: secret({ hosts: [] }) } }))],
    [
      'secret hosts a URL',
      helpers(({ secret }) => ({ env: { A_KEY: secret({ hosts: ['https://x.com'] }) } })),
    ],
    [
      'secret in without hosts',
      helpers(({ secret }) => ({ env: { A_KEY: secret({ in: ['query'] }) } })),
    ],
    [
      'secret in unknown',
      helpers(({ secret }) => ({
        env: { A_KEY: secret({ hosts: ['x.com'], in: ['cookie' as never] }) },
      })),
    ],
    [
      'secret in empty',
      helpers(({ secret }) => ({ env: { A_KEY: secret({ hosts: ['x.com'], in: [] }) } })),
    ],
    [
      'secret.fromEnv a bad name',
      helpers(({ secret }) => ({ env: { A_KEY: secret.fromEnv('a-b') } })),
    ],
    [
      'secret good',
      helpers(({ secret }) => ({
        env: {
          A_KEY: secret.fromEnv('B', { hosts: secret.hosts.gemini, in: ['header', 'query'] }),
        },
      })),
    ],
    ['data: secret with a typo', options({ env: { A_KEY: { kind: 'secret', host: ['x.com'] } } })],
    ['data: secret to unknown', options({ env: { A_KEY: { kind: 'secret', to: 'host' } } })],
    [
      'skill placement unknown',
      helpers(({ skill }) => ({
        skills: [skill.registry('o/r@s', { placement: 'home' as never })],
      })),
    ],
    [
      'skill exclude not a list',
      helpers(({ skill }) => ({
        skills: [skill.git('github:o/r', { exclude: 'evals' as never })],
      })),
    ],
    [
      'skill exclude an empty path',
      helpers(({ skill }) => ({ skills: [skill.npm('pkg@1', { exclude: ['/'] })] })),
    ],
    ['skill.git without a repo', helpers(({ skill }) => ({ skills: [skill.git('')] }))],
    [
      'skill.registry a bad id',
      helpers(({ skill }) => ({ skills: [skill.registry('owner/repo')] })),
    ],
    ['skills not from the helper', env({ skills: ['./skills'] })],
    ['skills not a list', env({ skills: 'x' })],
    [
      'skill good',
      helpers(({ skill }) => ({
        skills: [skill.inline({ name: 'n', description: 'd', content: 'c' })],
      })),
    ],
    [
      'data: skill with a typo',
      env({
        skills: [
          { kind: 'skill', source: 'registry', id: 'o/r@s', placement: 'harness', verison: '1' },
        ],
      }),
    ],
    [
      'data: skill with an unknown source',
      env({ skills: [{ kind: 'skill', source: 'ftp', placement: 'harness' }] }),
    ],
    ['mcp.stdio without a command', helpers(({ mcp }) => ({ mcp: { s: mcp.stdio('') } }))],
    ['mcp not from the helper', env({ mcp: { s: { command: 'npx' } } })],
    [
      'mcp good',
      helpers(({ mcp, secret }) => ({
        mcp: {
          s: mcp.http('https://x.com/mcp', {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
            headers: { a: secret.template('Bearer ${T}') },
          }),
        },
      })),
    ],
    [
      'data: mcp stdio without args',
      env({ mcp: { s: { kind: 'mcp', transport: 'stdio', command: 'npx' } } }),
    ],
    [
      'data: mcp with a bad transport',
      env({ mcp: { s: { kind: 'mcp', transport: 'ws', url: 'wss://x' } } }),
    ],
    ['file with backslashes', env({ files: { 'a\\b.txt': 'x' } })],
    ['file absolute', env({ files: { '/etc/x': 'x' } })],
    ['file with ..', env({ files: { '../x': 'x' } })],
    ['file a number', env({ files: { 'a.txt': 1 } })],
    [
      'file good',
      helpers(({ file }) => ({ files: { 'a.txt': file(join(DIR, 'a.txt')), '~/b': 'b' } })),
    ],
    ['data: file with a typo', env({ files: { 'a.txt': { kind: 'file', pth: '/a' } } })],
    ['rules a number', env({ rules: 3 })],
    ['directory without a path', helpers(({ directory }) => ({ files: directory('') }))],
    [
      'directory options not an object',
      helpers(({ directory }) => ({ files: directory(DIR, 'x' as never) })),
    ],
    [
      'directory ignore',
      helpers(({ directory }) => ({ files: directory(DIR, { ignore: ['x'] } as never) })),
    ],
    [
      'directory into absolute',
      helpers(({ directory }) => ({ files: directory(DIR, { into: '/abs' }) })),
    ],
    [
      'directory glob not a list',
      helpers(({ directory }) => ({ files: directory(DIR, { glob: 'x' as never }) })),
    ],
    [
      'directory defaultIgnores a string',
      helpers(({ directory }) => ({ files: directory(DIR, { defaultIgnores: 'no' as never }) })),
    ],
    ['directory missing', helpers(({ directory }) => ({ files: directory(join(DIR, 'nope')) }))],
    ['directory a file', helpers(({ directory }) => ({ files: directory(join(DIR, 'a.txt')) }))],
    ['directory empty', helpers(({ directory }) => ({ files: directory(join(DIR, 'empty')) }))],
    ['git without a repo', helpers(({ git }) => ({ workspace: git('') }))],
    [
      'git with a password',
      helpers(({ git }) => ({ workspace: git('https://u:p@github.com/o/r') })),
    ],
    [
      'git options not an object',
      helpers(({ git }) => ({ workspace: git('github:o/r', 'main' as never) })),
    ],
    [
      'git branch',
      helpers(({ git }) => ({ workspace: git('github:o/r', { branch: 'main' } as never) })),
    ],
    ['git ref an option', helpers(({ git }) => ({ workspace: git('github:o/r', { ref: '-x' }) }))],
    [
      'git path with ..',
      helpers(({ git }) => ({ workspace: git('github:o/r', { path: '../x' }) })),
    ],
    [
      'git init a string',
      helpers(({ git }) => ({ workspace: git('github:o/r', { init: 'yes' as never }) })),
    ],
    [
      'git token a token',
      helpers(({ git }) => ({ workspace: git('https://github.com/o/r', { token: 'ghp_abc' }) })),
    ],
    [
      'git token over ssh',
      helpers(({ git }) => ({
        workspace: git('git@github.com:o/r.git', { token: 'GITHUB_TOKEN' }),
      })),
    ],
    [
      'git good',
      helpers(({ git }) => ({
        workspace: git('https://github.com/o/r', {
          ref: 'v1.0.0',
          path: 'app/',
          token: 'GH_TOKEN',
        }),
      })),
    ],
    ['workspace not from git', env({ workspace: 'https://github.com/o/r' })],
    [
      'data: workspace with a typo',
      env({ workspace: { kind: 'git', repo: 'r', url: 'r', rf: 'main' } }),
    ],
  ],
  environment: [
    ['a bad name', any(defineEnvironment, 'a b', {})],
    ['not an object', any(defineEnvironment, 'e', 'x')],
    ['a callback returning a Promise', any(defineEnvironment, 'e', async () => ({}))],
    ['an image field', env({ image: 'node:22' })],
    ['an image field with steps', env({ image: ['npm i'] })],
    ['install beside the sandbox', env({ install: ['x'] })],
    ['steps instead of setup', env({ steps: ['x'] })],
    ['an unknown field', env({ colour: 'blue' })],
    ['a sandbox that is not one', env({ sandbox: 'docker' })],
    ['a sandbox maxConcurrent 0', env({ sandbox: { kind: 'fake', maxConcurrent: 0 } })],
    ['setup not a list', env({ setup: 'npm i' })],
    ['a setup step that is empty', env({ setup: [' '] })],
    ['a setup step with an extra key', env({ setup: [{ run: 'x', env: {} }] })],
    ['a setup step cwd empty', env({ setup: [{ run: 'x', cwd: '' }] })],
    ['a setup step that is a number', env({ setup: [3] })],
    ['extend a bad name', () => e1.extend('a b', {})],
    ['extend an unknown field', () => e1.extend('c', { colour: 'blue' } as never)],
    [
      'good',
      env({
        sandbox: { kind: 'fake' },
        setup: ['ls', { run: 'x', timeout: '1m', cwd: 'app' }],
        rules: '# rules',
        files: { 'a.txt': 'a' },
      }),
    ],
    ['options: a list', options({ environment: [e1] })],
    ['options: not an environment', options({ environment: 'one' })],
    ['data: a typo in a layer', options({ environment: envData({ setpu: [] }) })],
    ['data: a bad setup step', options({ environment: envData({ setup: [{ run: '' }] }) })],
    [
      'data: a layer without a spec',
      options({ environment: { kind: 'environment', name: 'x', layers: [{ name: 'x' }] } }),
    ],
    [
      'data: a bad name',
      options({ environment: { kind: 'environment', name: 'a b', layers: [] } }),
    ],
    ['data: good', options({ environment: envData({ setup: ['ls'], files: { 'a.txt': 'a' } }) })],
  ],
}
