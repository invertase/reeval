// Every refusal of the SDK-facing contract, by segment: an input and the call that checks it.
// test/refusals.test.ts runs each and holds its exact message (or `null`, accepted) to
// test/refusals/<segment>.json, so a change of wording, or of what's accepted, shows as a diff.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseYamlConfig, resolveConfig, resolveConfigData } from '../../src/config.ts'
import {
  attemptAbortProblem,
  attemptDoneProblem,
  attemptRequestProblem,
  attemptStartProblem,
  execOptionsProblem,
} from '../../src/contract/attempt.ts'
import { declarationProblem } from '../../src/contract/declaration.ts'
import { buildRefusal, readMarketplace } from '../../src/environment/plugins.ts'
import { defineEnvironment } from '../../src/environment.ts'
import { UsageError } from '../../src/errors.ts'
import { resolveModelGateway } from '../../src/gateway/models.ts'
import { resolveGateway } from '../../src/gateway/resolve.ts'
import { vercelCredentialProblem } from '../../src/gateway/vercel.ts'
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fakeHarness,
  fx,
  goose,
  grokBuild,
  opencode,
  pi,
} from '../../src/harness.ts'
import { checkHarnesses, checkOptions } from '../../src/options.ts'
import { planEval } from '../../src/plan-eval.ts'
import { docker, fakeSandbox, podman } from '../../src/sandbox.ts'
import type {
  EnvironmentHelpers,
  GatewayDescriptor,
  GatewayName,
  HarnessDescriptor,
  PluginSource,
  SandboxDescriptor,
} from '../../src/types.ts'

export type Case = [name: string, run: () => unknown]

const WHERE = 'evals/a.eval.ts › e'
const options = (o: unknown) => () => checkOptions(o as object, WHERE)
const harnesses =
  (...list: unknown[]) =>
  () =>
    checkHarnesses(list, WHERE)
const config = (c: unknown) => () => resolveConfig(c as never, '/project', 'reeval.config.ts')
const yaml = (text: string) => () =>
  resolveConfigData(parseYamlConfig(text, 'reeval.yaml'), '/project', 'reeval.yaml')
const configIn = (c: unknown) => () => resolveConfig(c as never, DIR, 'reeval.config.ts')
const yamlIn = (text: string) => () =>
  resolveConfigData(parseYamlConfig(text, 'reeval.yaml'), DIR, 'reeval.yaml')
const env = (spec: unknown) => () => defineEnvironment('e', spec as never)
const helpers = (use: (h: EnvironmentHelpers) => unknown) => () =>
  defineEnvironment('e', (h) => ({ files: { 'a.txt': 'a' }, ...(use(h) as object) }))
/** What the plan says of a plugin's build in a sandbox. */
const build = (p: PluginSource, sandbox: SandboxDescriptor, name?: string) => () => {
  const refusal = buildRefusal(p, sandbox, name)
  if (refusal) throw new UsageError(refusal)
}
const any =
  // biome-ignore lint/suspicious/noExplicitAny: refusals are about values the types refuse
    (f: (...args: any[]) => unknown, ...args: unknown[]) =>
    () =>
      f(...args)

/** Which gateway a harness resolves to in a list, with reeval's own gateways. */
const route = (gateways: GatewayDescriptor[], harness: HarnessDescriptor) => () =>
  resolveGateway(gateways, harness, WHERE)
/** Which gateway a model reeval calls itself (the judge's) resolves to in a list. */
const model = (name: string, pin: GatewayName | undefined, gateways: GatewayDescriptor[]) => () =>
  resolveModelGateway(name, pin, { gateways }, 'the judge model')
const VERCEL: GatewayDescriptor = { kind: 'vercel' }
const DIRECT: GatewayDescriptor = { kind: 'direct' }
const OPENROUTER: GatewayDescriptor = { kind: 'openrouter' }
/** What the plan says of Vercel's credentials, at noon on 1 January 2026. */
const oidc = (env: NodeJS.ProcessEnv) => () => {
  const problem = vercelCredentialProblem(env, new Date('2026-01-01T12:00:00Z'))
  if (problem) throw new UsageError(problem)
}
const jwt = (expiresMs: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp: expiresMs / 1000 })).toString('base64url')}.sig`

/** A directory with one file and an empty subdirectory, for `directory()`, and a Dockerfile. */
export const DIR = mkdtempSync(join(tmpdir(), 'reeval-refusals-'))
writeFileSync(join(DIR, 'a.txt'), 'a')
writeFileSync(join(DIR, 'Dockerfile'), 'FROM debian:bookworm-slim\n')
mkdirSync(join(DIR, 'empty'))

/** A marketplace whose review entry is a `file:` URL on this machine. */
const hostEntry = () => {
  const dir = join(DIR, 'host-market')
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'acme',
      plugins: [{ name: 'review', source: { source: 'url', url: 'file:///srv/review' } }],
    }),
  )
  return dir
}

/** What planning an eval with `options` refuses under `secrets: { unbrokered: 'error' }`. */
const strict = (o: unknown) => () => {
  const config = resolveConfig(
    { harness: fakeHarness(), sandbox: fakeSandbox(), secrets: { unbrokered: 'error' } },
    DIR,
    'reeval.config.ts',
  )
  planEval(
    { name: 'e', mode: 'run', groups: [], options: o as never },
    { config, profile: null, tags: [], concurrency: 1, file: undefined, order: 0 },
  )
}
/** An environment with one MCP server on `url` that sends `headers`. */
const mcpHeaders = (url: string, headers: Record<string, unknown>) =>
  defineEnvironment('e', ({ mcp }) => ({ mcp: { docs: mcp.http(url, { headers } as never) } }))

/** What `declareTree` checks before it declares anything. */
const tree = (children: unknown) => () => {
  const problem = declarationProblem(children)
  if (problem) throw new UsageError(problem)
}
const evalNode = (o: object = {}) => ({
  type: 'eval',
  name: 'e',
  mode: 'run',
  options: {},
  body: 'b1',
  ...o,
})

/** What a runner's attempt request is checked against. */
const request =
  (call: unknown, id: unknown = '1') =>
  () => {
    const problem = attemptRequestProblem({ id, call })
    if (problem) throw new UsageError(problem)
  }
const execOptions = (options: unknown) => () => {
  const problem = execOptionsProblem(options)
  if (problem) throw new UsageError(problem)
}
const lifecycle = (problemOf: (value: unknown) => string | undefined, value: unknown) => () => {
  const problem = problemOf(value)
  if (problem) throw new UsageError(problem)
}
const cell = {
  key: 'fake-plain-docker-98d88a',
  harness: 'fake',
  environment: 'plain',
  sandbox: 'docker',
  role: 'control',
}
const start = (o: object = {}) =>
  lifecycle(attemptStartProblem, {
    type: 'start',
    attempt: { id: 'a1b2', cell, n: 1 },
    file: 'evals/greet.eval.ts',
    body: 'greets',
    ...o,
  })
const expectCall = (o: object = {}) => ({
  op: 'expect',
  subject: { attempt: true },
  matcher: 'toHaveFile',
  args: ['greet.js'],
  not: false,
  soft: false,
  ...o,
})

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
    ['a from with a line break', any(docker, { from: 'node:24\nRUN id' })],
    ['a from with a space', any(docker, { from: 'node:24 AS tools' })],
    ['secrets on the sandbox', any(docker, { env: {} })],
    ['environment on the sandbox', any(docker, { environment: {} })],
    ['an unknown key and a bad value', any(docker, { cpus: 0, mem: '1g' })],
    ['two bad values', any(docker, { pids: 0, root: 'yes' })],
    ['a good one', any(docker, { from: 'node:24', memory: '4g', swap: 0, install: ['ls'] })],
    ['podman: a memory size podman does not take', any(podman, { memory: '4GB' })],
    ['podman: an unknown key', any(podman, { colour: 'blue' })],
    ['podman: a good one', any(podman, { from: 'node:24', memory: '4g', install: ['ls'] })],
    ['data: not docker() or fakeSandbox()', options({ sandbox: { kind: 'vm' } })],
    [
      'data: podman with a bad memory',
      options({ sandbox: { kind: 'docker', engine: 'podman', memory: '4GB' } }),
    ],
    ['data: an unknown engine', options({ sandbox: { kind: 'docker', engine: 'lxc' } })],
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
    ['opencode with a vercel/ id', any(opencode, { model: 'vercel/anthropic/claude-haiku-4.5' })],
    [
      'opencode with an openrouter/ id',
      any(opencode, { model: 'openrouter/anthropic/claude-haiku-4.5' }),
    ],
    ['opencode good', any(opencode, { model: 'google/gemini-3.8-flash' })],
    ['goose with a provider', any(goose, { model: 'google/gemini-3.8-flash' })],
    ['goose without a model', any(goose, {})],
    ['pi with a provider', any(pi, { model: 'google/gemini-3.8-flash' })],
    ['pi effort empty', any(pi, { model: 'gemini-3.8-flash', effort: '' })],
    ['codex with a provider', any(codex, { model: 'openai/gpt-5.6-luna' })],
    ['codex without a model', any(codex, {})],
    ['grokBuild with a provider', any(grokBuild, { model: 'xai/grok-4.6' })],
    ['grokBuild without a model', any(grokBuild, {})],
    ['grokBuild effort empty', any(grokBuild, { model: 'grok-4.6', effort: '' })],
    ['grokBuild good', any(grokBuild, { model: 'grok-4.6', effort: 'high' })],
    ['fx without a model', any(fx, {})],
    ['fx with an empty model', any(fx, { model: '' })],
    ['fx with a typo', any(fx, { model: 'gpt-4.1', efort: 'high' })],
    ['fx good', any(fx, { model: 'anthropic/claude-sonnet-5' })],
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
    ['data: grok-build with a provider', harnesses({ kind: 'grok-build', model: 'xai/g' })],
    ['data: fx without a model', harnesses({ kind: 'fx' })],
    ['data: fake with a bad layout', harnesses({ kind: 'fake', layout: 'vim' })],
    ['data: fake with a bad script', harnesses({ kind: 'fake', script: [{ exec: 'ls' }] })],
    ['data: good', harnesses({ kind: 'cursor', model: 'm' }, { kind: 'fake', id: 'f' })],
  ],
  judge: [
    ['threshold above 1', options({ judge: { threshold: 2 } })],
    ['threshold a string', options({ judge: { threshold: '0.5' } })],
    ['maxConcurrent 0', options({ judge: { maxConcurrent: 0 } })],
    ['diff outside state', options({ judge: { diff: ['src/'] } })],
    ['contents outside state', options({ judge: { contents: ['a.ts'] } })],
    ['on outside a call', options({ judge: { on: 'x' } })],
    ['state not an object', options({ judge: { state: 'tools' } })],
    ['state with a typo', options({ judge: { state: { transcrpt: true } } })],
    ['state.diff empty', options({ judge: { state: { diff: [] } } })],
    ['state.diff with an empty pattern', options({ judge: { state: { diff: ['src/', ' '] } } })],
    ['state.contents not a list', options({ judge: { state: { contents: 'a.ts' } } })],
    ['state.transcript unknown', options({ judge: { state: { transcript: 'all' } } })],
    ['state.turns unknown', options({ judge: { state: { turns: 'first' } } })],
    ['state.checks a string', options({ judge: { state: { checks: 'npm test' } } })],
    ['a typo', options({ judge: { treshold: 0.5 } })],
    ['not an object', options({ judge: 'google/gemini-3.8-flash' })],
    ['maxConcurrent fractional', options({ judge: { maxConcurrent: 1.5 } })],
    ['providerOptions not an object', options({ judge: { providerOptions: 'fast' } })],
    [
      'providerOptions with a non-object provider',
      options({ judge: { providerOptions: { google: 'fast' } } }),
    ],
    ['providerOptions good', options({ judge: { providerOptions: { google: { a: [1] } } } })],
    [
      'good',
      options({
        judge: {
          threshold: 0.5,
          maxConcurrent: 2,
          state: { diff: ['src/**'], transcript: 'tools', turns: 'all', checks: ['npm test'] },
        },
      }),
    ],
    ['config: model without a provider', config({ judge: { model: 'jev' } })],
    ['config: model an object', config({ judge: { model: { specificationVersion: 'v2' } } })],
    [
      'config: fake judge score function',
      config({ judge: { model: { kind: 'fake-judge', score: () => 1 } } }),
    ],
    ['config: threshold above 1', config({ judge: { threshold: 1.5 } })],
    ['config: fake judge', config({ judge: { model: { kind: 'fake-judge', score: 0.9 } } })],
    ['config: a typo', config({ judge: { modle: 'google/gemini-3.8-flash' } })],
    ['config: state.contents with an empty path', config({ judge: { state: { contents: [''] } } })],
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
    ['an unknown key', options({ compare: { variants: [e2], arms: [] } })],
    ['gate unknown', options({ compare: { variants: [e2], gate: 'some' } })],
    ['minLift above 1', options({ compare: { variants: [e2], minLift: 2 } })],
    ['minLift a string', options({ compare: { variants: [e2], minLift: '0.1' } })],
    ['harness not a list', options({ compare: { variants: [e2], harness: 'cursor' } })],
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
        },
      }),
    ],
    [
      'data: a variant with a bad spec',
      options({ compare: { variants: [envData({ setpu: [] })] } }),
    ],
  ],
  questions: [
    ['not a list', options({ questions: 'Which?' })],
    ['a question that is empty', options({ questions: [' '] })],
    ['a question that is a number', options({ questions: [3] })],
    ['a question with an unknown key', options({ questions: [{ question: 'Q', by: 'm' }] })],
    ['a question with cuts', options({ questions: [{ question: 'Q', cuts: 'x' }] })],
    ['a question without its text', options({ questions: [{ model: 'google/g' }] })],
    [
      'a question model without a provider',
      options({ questions: [{ question: 'Q', model: 'g' }] }),
    ],
    [
      'a question model that is an evaluation model',
      options({ questions: [{ question: 'Q', model: 'typesafe-ai/jev-1.14.0' }] }),
    ],
    ['across unknown', options({ questions: [{ question: 'Q', across: 'cell' }] })],
    ['across an empty list', options({ questions: [{ question: 'Q', across: [] }] })],
    ['across twice', options({ questions: [{ question: 'Q', across: ['harness', 'harness'] }] })],
    ['choices a string', options({ questions: [{ question: 'Q', choices: 'yes' }] })],
    ['choices of one', options({ questions: [{ question: 'Q', choices: ['yes'] }] })],
    ['choices twice', options({ questions: [{ question: 'Q', choices: ['yes', 'yes'] }] })],
    [
      'choices with an empty answer',
      options({ questions: [{ question: 'Q', choices: ['yes', ''] }] }),
    ],
    [
      'choices with across',
      options({ questions: [{ question: 'Q', across: 'environment', choices: ['a', 'b'] }] }),
    ],
    ['a question twice', options({ questions: ['Q', { question: 'Q' }] })],
    [
      'a question state with contents',
      options({ questions: [{ question: 'Q', state: { contents: ['a'] } }] }),
    ],
    [
      'a question state with an unknown key',
      options({ questions: [{ question: 'Q', state: { dif: true } }] }),
    ],
    [
      'a question state with a bad turns',
      options({ questions: [{ question: 'Q', state: { turns: 'first' } }] }),
    ],
    ['artifacts an empty list', options({ questions: [{ question: 'Q', artifacts: [] }] })],
    ['artifacts false', options({ questions: [{ question: 'Q', artifacts: false }] })],
    ['the question option a string', options({ question: 'diff' })],
    ['good: the question option with a model', options({ question: { model: 'google/g' } })],
    ['the question option with a model without a provider', options({ question: { model: 'g' } })],
    [
      'the question option with an evaluation model',
      options({ question: { model: 'typesafe-ai/jev-1.14.0' } }),
    ],
    ['the question option with a model object', options({ question: { model: { kind: 'x' } } })],
    ['the question option with across', options({ question: { across: 'harness' } })],
    ['the question option with choices', options({ question: { choices: ['a', 'b'] } })],
    ['the question option with an unknown key', options({ question: { stat: {} } })],
    [
      'the question option with an unknown state key',
      options({ question: { state: { transcripts: true } } }),
    ],
    [
      'good: question state and artifacts',
      options({
        question: { state: { checks: ['npm test'] } },
        questions: [
          { question: 'Q', state: { diff: false, output: true }, artifacts: ['home'] },
          { question: 'R', artifacts: true, across: 'environment' },
        ],
      }),
    ],
    [
      'good',
      options({
        compare: { variants: [e2] },
        questions: [
          'Q',
          { question: 'R', model: 'google/g', across: ['environment', 'harness'] },
          { question: 'S', choices: ['yes', 'no'] },
        ],
      }),
    ],
    ['config: questions', config({ questions: ['Q'] })],
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
      'data: secret with a URL host',
      options({ env: { A_KEY: { kind: 'secret', hosts: ['https://x.com'] } } }),
    ],
    [
      'data: secret in without hosts',
      options({ env: { A_KEY: { kind: 'secret', in: ['query'] } } }),
    ],
    ['data: secret from a bad name', options({ env: { A_KEY: { kind: 'secret', from: 'a-b' } } })],
    [
      'data: secret good',
      options({ env: { A_KEY: { kind: 'secret', from: 'B', hosts: ['x.com'], in: ['body'] } } }),
    ],
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
    [
      'plugin only an unknown part',
      helpers(({ plugin }) => ({
        plugins: [plugin.local('.', { only: ['apps' as never] })],
      })),
    ],
    [
      'plugin only empty',
      helpers(({ plugin }) => ({ plugins: [plugin.local('.', { only: [] })] })),
    ],
    [
      'plugin option with a typo',
      helpers(({ plugin }) => ({
        plugins: [plugin.git('github:o/r', { refs: 'v1' } as never)],
      })),
    ],
    [
      'plugin build not a command',
      helpers(({ plugin }) => ({ plugins: [plugin.npm('pkg@1', { build: 3 as never })] })),
    ],
    ['plugin.git without a repo', helpers(({ plugin }) => ({ plugins: [plugin.git('')] }))],
    [
      'plugin.git with credentials',
      helpers(({ plugin }) => ({
        plugins: [plugin.git('https://user:token@github.com/o/r')],
      })),
    ],
    ['plugin.npm without a spec', helpers(({ plugin }) => ({ plugins: [plugin.npm('')] }))],
    [
      'plugin.marketplace without a name',
      helpers(({ plugin }) => ({ plugins: [plugin.marketplace('github:acme/agent-plugins')] })),
    ],
    [
      'plugin.marketplace name not kebab-case',
      helpers(({ plugin }) => ({ plugins: [plugin.marketplace('Lint@github:acme/tools')] })),
    ],
    [
      'plugin.marketplace ref on npm',
      helpers(({ plugin }) => ({
        plugins: [plugin.marketplace('lint@npm:@acme/plugins@2.0.0', { ref: 'v1' })],
      })),
    ],
    [
      'plugin.marketplace tree URL',
      helpers(({ plugin }) => ({
        plugins: [plugin.marketplace('lint@https://github.com/acme/tools/tree/v1/market')],
      })),
    ],
    [
      'plugin.marketplace option with a typo',
      helpers(({ plugin }) => ({
        plugins: [plugin.marketplace('lint@github:acme/tools', { path: 'x' } as never)],
      })),
    ],
    [
      'plugin.marketplace with credentials',
      helpers(({ plugin }) => ({
        plugins: [plugin.marketplace('lint@https://user:token@github.com/acme/tools')],
      })),
    ],
    [
      'plugin.marketplace good',
      helpers(({ plugin }) => ({
        plugins: [
          plugin.marketplace('lint@github:acme/tools', { ref: 'v3', only: ['skills'] }),
          plugin.marketplace('format@npm:@acme/plugins@2.0.0'),
        ],
      })),
    ],
    [
      'marketplace entry on this machine, from a remote marketplace',
      () =>
        readMarketplace(hostEntry(), 'call', 'https://git.example.com/acme/plugins.git', 'review'),
    ],
    [
      'marketplace entry on this machine, from a local marketplace',
      () => readMarketplace(hostEntry(), 'call', 'market', 'review', true),
    ],
    ['plugins not from the helper', env({ plugins: ['./plugins/review'] })],
    ['plugins not a list', env({ plugins: 'x' })],
    [
      'plugin good',
      helpers(({ plugin }) => ({
        plugins: [
          plugin.local('.', { only: ['skills'] }),
          plugin.git('github:o/r', { ref: 'v1', path: 'plugins/review' }),
          plugin.npm('pkg@1', { only: ['mcp'], build: ['npm ci', 'npm run build'] }),
        ],
      })),
    ],
    [
      'data: plugin with a typo',
      env({ plugins: [{ kind: 'plugin', source: 'local', path: '/p', onyl: ['skills'] }] }),
    ],
    [
      'data: plugin with an unknown source',
      env({ plugins: [{ kind: 'plugin', source: 'zip', name: 'x' }] }),
    ],
    [
      'data: plugin marketplace without its source',
      env({ plugins: [{ kind: 'plugin', source: 'marketplace', name: 'x' }] }),
    ],
    [
      'data: plugin marketplace with a typo',
      env({
        plugins: [
          {
            kind: 'plugin',
            source: 'marketplace',
            name: 'x',
            marketplace: { source: 'git', repo: 'github:o/r', rev: 'v1' },
          },
        ],
      }),
    ],
    [
      'data: plugin build empty',
      env({ plugins: [{ kind: 'plugin', source: 'npm', spec: 'pkg@1', build: [] }] }),
    ],
    [
      'plugin build from the source root',
      helpers(({ plugin }) => ({
        plugins: [
          plugin.git('github:o/r', { path: 'plugins/review', build: { run: 'pnpm i', cwd: '.' } }),
        ],
      })),
    ],
    [
      'plugin build cwd outside the source',
      helpers(({ plugin }) => ({
        plugins: [plugin.git('github:o/r', { build: { run: 'make', cwd: '../x' } })],
      })),
    ],
    [
      'plugin build with an unknown key',
      helpers(({ plugin }) => ({
        plugins: [plugin.npm('pkg@1', { build: { run: 'make', dir: '.' } as never })],
      })),
    ],
    [
      'plugin build without run',
      helpers(({ plugin }) => ({
        plugins: [plugin.npm('pkg@1', { build: { cwd: '.' } as never })],
      })),
    ],
    [
      'data: plugin build cwd absolute',
      env({
        plugins: [
          { kind: 'plugin', source: 'npm', spec: 'pkg@1', build: { run: 'make', cwd: '/src' } },
        ],
      }),
    ],
    [
      'plugin build on the fake sandbox',
      build(
        { kind: 'plugin', source: 'npm', spec: 'pkg@1', build: 'make' },
        fakeSandbox(),
        'review',
      ),
    ],
    [
      'plugin build on the fake sandbox, before its manifest is read',
      build({ kind: 'plugin', source: 'git', repo: 'github:o/r', build: 'make' }, fakeSandbox()),
    ],
    [
      'plugin build on docker',
      build({ kind: 'plugin', source: 'npm', spec: 'pkg@1', build: 'make' }, docker(), 'review'),
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
    [
      'data: mcp http with a bad url',
      env({ mcp: { s: { kind: 'mcp', transport: 'http', url: 'not a url', headers: {} } } }),
    ],
    [
      'data: mcp http good',
      env({
        mcp: {
          s: { kind: 'mcp', transport: 'http', url: 'https://x.com/mcp', headers: { a: 'b' } },
        },
      }),
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
    [
      'data: workspace with a literal token',
      env({ workspace: { kind: 'git', repo: 'r', url: 'r', token: 'ghp_abc-123' } }),
    ],
    ['data: workspace good', env({ workspace: { kind: 'git', repo: 'r', url: 'r', ref: 'v1' } })],
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
    [
      'a missing dockerfile as data',
      env({ sandbox: { kind: 'docker', dockerfile: join(DIR, 'nope/Dockerfile') } }),
    ],
    [
      'a dockerfile as data',
      env({ sandbox: { kind: 'docker', dockerfile: join(DIR, 'Dockerfile') } }),
    ],
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
  config: [
    [
      "unbrokered 'error': a plain MCP header named like a credential",
      strict({
        environment: mcpHeaders('https://mcp.example.com', { Authorization: 'Bearer abc123' }),
      }),
    ],
    [
      "unbrokered 'error': a plain MCP header with a token's shape, on http://",
      strict({
        environment: mcpHeaders('http://localhost:4000', {
          'X-Trace': 'ghp_0123456789abcdefghijABCDEFGHIJ0123456789',
        }),
      }),
    ],
    [
      "unbrokered 'error': a plain MCP header from a declaration tree",
      strict({
        environment: {
          kind: 'environment',
          name: 'e',
          layers: [
            {
              name: 'e',
              spec: {
                mcp: {
                  docs: {
                    kind: 'mcp',
                    transport: 'http',
                    url: 'https://mcp.example.com',
                    headers: { 'x-session-token': 'abc123' },
                  },
                },
              },
            },
          ],
        },
      }),
    ],
    [
      "unbrokered 'error': a neutral plain MCP header",
      strict({ environment: mcpHeaders('https://mcp.example.com', { 'X-Request-Source': 'ci' }) }),
    ],
    [
      "unbrokered 'error': a secret.template MCP header on https://",
      strict({
        environment: defineEnvironment('e', ({ mcp, secret }) => ({
          mcp: {
            docs: mcp.http('https://mcp.example.com', {
              // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
              headers: { Authorization: secret.template('Bearer ${MCP_TOKEN}') },
            }),
          },
        })),
      }),
    ],
    ['yaml: empty', yaml('')],
    ['yaml: not YAML', yaml('harness: [a\n')],
    ['yaml: a repeated key', yaml('runs: 1\nruns: 2\n')],
    ['yaml: a list', yaml('- runs: 1\n')],
    ['yaml: a scalar', yaml('runs\n')],
    ['yaml: an unknown key', yaml('harnesses: []\n')],
    ['yaml: runs 0', yaml('runs: 0\n')],
    ['yaml: runs null', yaml('runs:\n')],
    ['yaml: include null', yaml('include:\n')],
    ['yaml: a typo in history', yaml('history:\n  dirr: runs\n')],
    ['yaml: history.dir a number', yaml('history:\n  dir: 3\n')],
    ['yaml: a typo in debug', yaml('debug:\n  keepRuns: 3\n')],
    ['yaml: defaultProfile null', yaml('defaultProfile:\n')],
    ['yaml: compare', yaml('compare:\n  variants: []\n')],
    ['yaml: questions', yaml('questions:\n  - Q\n')],
    ['yaml: a literal secret', yaml('env:\n  API_KEY: abc\n')],
    [
      'yaml: a secret as data',
      yaml('env:\n  API_KEY:\n    kind: secret\n    hosts: [api.example.com]\n'),
    ],
    [
      'yaml: a secret with a typo',
      yaml('env:\n  API_KEY:\n    kind: secret\n    host: [api.example.com]\n'),
    ],
    ['yaml: a harness without a kind', yaml('harness:\n  model: composer-2.5\n')],
    [
      'yaml: a harness with a typo',
      yaml('harness:\n  kind: cursor\n  model: composer-2.5\n  modle: x\n'),
    ],
    ['yaml: an empty harness list', yaml('harness: []\n')],
    [
      'yaml: a fake judge with a string score',
      yaml('judge:\n  model:\n    kind: fake-judge\n    score: high\n'),
    ],
    ['yaml: a fake judge above 1', yaml('judge:\n  model:\n    kind: fake-judge\n    score: 2\n')],
    ['yaml: a judge model without a provider', yaml('judge:\n  model: jev\n')],
    ['yaml: a typo in judge.state', yaml('judge:\n  state:\n    transcrpt: true\n')],
    [
      'yaml: providerOptions as data',
      yaml(
        'judge:\n  model: google/gemini-3.8-flash\n  providerOptions:\n    google:\n      thinkingConfig: { thinkingBudget: 0 }\n',
      ),
    ],
    ['yaml: environment a name', yaml('environment: base\n')],
    ['yaml: environment without layers', yaml('environment:\n  kind: environment\n  name: base\n')],
    [
      'yaml: environment layer with a typo',
      yaml(
        'environment:\n  kind: environment\n  name: base\n  layers:\n    - name: base\n      spec: { file: {} }\n',
      ),
    ],
    [
      'yaml: environment as data',
      yaml(
        'environment:\n  kind: environment\n  name: base\n  layers:\n    - name: base\n      spec:\n        files: { a.txt: hi }\n        setup: [ls]\n',
      ),
    ],
    ['yaml: a profile with an unknown key', yaml('profiles:\n  pr:\n    limits: { runs: 1 }\n')],
    ['yaml: a profile limit runs 0', yaml('profiles:\n  pr:\n    limit: { runs: 0 }\n')],
    [
      'yaml: a profile limit with a typo',
      yaml('profiles:\n  pr:\n    limit: { compare: { maxVariant: 1 } }\n'),
    ],
    [
      'yaml: a profile defaults environment a name',
      yaml('profiles:\n  pr:\n    defaults: { environment: base }\n'),
    ],
    ['yaml: a profile null', yaml('profiles:\n  pr:\n')],
    ['yaml: defaultProfile not in profiles', yaml('defaultProfile: { ci: pr }\n')],
    [
      'yaml: analysis fake with a typo',
      yaml('analysis:\n  model: { kind: fake-analysis, votes: tie }\n'),
    ],
    ['yaml: analysis agent', yaml('analysis:\n  agent: true\n')],
    ['yaml: analysis maxTokens 0', yaml('analysis:\n  maxTokens: 0\n')],
    [
      'yaml: capture viewport not whole',
      yaml('capture:\n  viewport: { width: 10.5, height: 10 }\n'),
    ],
    ['yaml: a budget with a typo', yaml('budget: { attempt: 3 }\n')],
    ['yaml: question with a model', yaml('question: { model: google/g }\n')],
    ['yaml: question with a bare model', yaml('question: { model: gemini }\n')],
    ['yaml: question state contents', yaml('question:\n  state: { contents: [a] }\n')],
    ['yaml: question good', yaml('question:\n  state: { output: true, diff: false }\n')],
    [
      'yaml: good',
      yaml(`include: ['evals/**/*.eval.ts']
harness:
  - { kind: fake, id: a }
  - { kind: cursor, model: composer-2.5 }
sandbox: { kind: fake }
runs: 2
gate: { passRate: 0.5 }
timeout: 90s
env:
  TOKEN: { kind: secret, from: HOST_TOKEN, hosts: [api.example.com] }
egress: { allow: [api.example.com] }
judge:
  model: { kind: fake-judge, score: 0.9 }
  threshold: 0.7
  state: { transcript: tools }
capture: { viewport: full-page, timeout: 30s }
concurrency: 2
record: manual
history: { dir: .history, artifacts: failures }
budget: { attempts: 20, duration: 1h }
defaultProfile: { ci: pr }
secrets: { unbrokered: error }
debug: { keep: 5, traceBufferMb: 2 }
analysis:
  model: { kind: fake-analysis, vote: { winner: A, reason: shorter } }
  insights: true
  maxTokens: 100000
  maxInputTokens: 4000
profiles:
  pr:
    limit: { runs: 1, compare: false, harness: [a] }
    budget: { attempts: 5 }
    tags: ['!slow']
  nightly:
    defaults:
      runs: 3
      environment:
        kind: environment
        name: nightly
        layers: [{ name: nightly, spec: { files: { a.txt: hi } } }]
    judge: { model: google/gemini-3.8-flash }
    record: always
`),
    ],
    [
      'yaml: a relative dockerfile',
      yamlIn('sandbox: { kind: docker, dockerfile: ./Dockerfile }\n'),
    ],
    [
      'yaml: a missing relative dockerfile',
      yamlIn('sandbox: { kind: docker, dockerfile: nope/Dockerfile }\n'),
    ],
    [
      'yaml: a missing dockerfile in a profile',
      yamlIn(
        'profiles:\n  big:\n    defaults:\n      sandbox: { kind: docker, dockerfile: big/Dockerfile }\n',
      ),
    ],
    [
      'yaml: a missing dockerfile in an environment layer',
      yamlIn(
        'environment:\n  kind: environment\n  name: base\n  layers:\n    - name: base\n      spec: { sandbox: { kind: docker, dockerfile: nope } }\n',
      ),
    ],
    [
      'yaml: relative host files, rules, skills and a local repository',
      yamlIn(`sandbox: { kind: fake, dir: ./tmp }
environment:
  kind: environment
  name: base
  layers:
    - name: base
      spec:
        workspace: { kind: git, repo: ../app, url: ../app }
        files: { a.txt: { kind: file, path: a.txt }, b.txt: inline }
        rules: { kind: file, path: ./a.txt }
        skills:
          - { kind: skill, source: local, path: ./skills, placement: harness }
          - { kind: skill, source: npm, spec: ./pkg.tgz, path: skills, placement: harness }
`),
    ],
    [
      'yaml: a host file with an empty path',
      yamlIn(
        'environment:\n  kind: environment\n  name: base\n  layers: [{ name: base, spec: { files: { a.txt: { kind: file, path: "" } } } }]\n',
      ),
    ],
    [
      'yaml: a local skill path a number',
      yamlIn(
        'environment:\n  kind: environment\n  name: base\n  layers: [{ name: base, spec: { skills: [{ kind: skill, source: local, path: 3, placement: harness }] } }]\n',
      ),
    ],
    [
      'yaml: a dockerfile that is a directory',
      yamlIn('sandbox: { kind: docker, dockerfile: empty }\n'),
    ],
    [
      'ts: a relative dockerfile as data',
      configIn({ sandbox: { kind: 'docker', dockerfile: './Dockerfile' } }),
    ],
    [
      'ts: a missing relative dockerfile as data',
      configIn({ sandbox: { kind: 'docker', dockerfile: 'nope/Dockerfile' } }),
    ],
    [
      'ts: a missing dockerfile as data in a profile',
      configIn({
        profiles: {
          big: { defaults: { sandbox: { kind: 'docker', dockerfile: 'big/Dockerfile' } } },
        },
      }),
    ],
    ['ts: a relative fake dir as data', configIn({ sandbox: { kind: 'fake', dir: './tmp' } })],
  ],
  gateway: [
    ['ts: an empty list', config({ gateway: [] })],
    ['ts: not a list', config({ gateway: { kind: 'direct' } })],
    ['ts: an unknown kind', config({ gateway: [{ kind: 'vercell' }] })],
    ['ts: a near miss', config({ gateway: [{ kind: 'dirct' }] })],
    ['ts: a duplicate', config({ gateway: [{ kind: 'direct' }, { kind: 'direct' }] })],
    ['ts: direct with a typo', config({ gateway: [{ kind: 'direct', apiKey: 'x' }] })],
    ['ts: a profile with an empty list', config({ profiles: { pr: { gateway: [] } } })],
    ['ts: good', config({ gateway: [{ kind: 'direct' }] })],
    ['yaml: an unknown name', yaml('gateway: [vercell]\n')],
    ['yaml: a map with two keys', yaml('gateway: [{ direct: {}, vercel: {} }]\n')],
    ['yaml: direct with options', yaml('gateway: [{ direct: { apiKey: x } }]\n')],
    ['yaml: a number', yaml('gateway: [3]\n')],
    ['yaml: good', yaml('gateway: [direct]\n')],
    ['harness: a pin not a name', any(fakeHarness, { gateway: 'vercell' })],
    ['harness: a pin a number', any(cursor, { model: 'm', gateway: 3 })],
    ['harness: a helper pin', any(fakeHarness, { gateway: { kind: 'direct' } })],
    ['ts: vercel with a typo', config({ gateway: [{ kind: 'vercel', apikey: 'x' }] })],
    ['ts: vercel then direct', config({ gateway: [{ kind: 'vercel' }, { kind: 'direct' }] })],
    ['yaml: vercel with options', yaml('gateway: [{ vercel: { apikey: x } }]\n')],
    ['yaml: vercel then direct', yaml('gateway: [vercel, direct]\n')],
    ['route: cursor on vercel alone', route([VERCEL], cursor({ model: 'composer-2.5' }))],
    ['route: antigravity on vercel alone', route([VERCEL], antigravity({ model: 'm' }))],
    ['route: grok build on vercel', route([VERCEL], grokBuild({ model: 'm' }))],
    ['route: opencode on vercel', route([VERCEL], opencode({ model: 'anthropic/m' }))],
    ['route: an fx gateway id on direct alone', route([DIRECT], fx({ model: 'google/m' }))],
    [
      'route: an fx gateway id falls through to vercel',
      route([DIRECT, VERCEL], fx({ model: 'google/m' })),
    ],
    [
      'route: cursor pinned to vercel',
      route([VERCEL, DIRECT], cursor({ model: 'composer-2.5', gateway: 'vercel' })),
    ],
    ['route: a pin not in the list', route([DIRECT], codex({ model: 'm', gateway: 'vercel' }))],
    ['route: codex on vercel', route([VERCEL, DIRECT], codex({ model: 'm' }))],
    ['route: claude code on vercel', route([VERCEL], claudeCode({ model: 'm' }))],
    ['route: pi on vercel alone', route([VERCEL], pi({ model: 'gemini-3.8-flash' }))],
    [
      'route: pi falls through to direct',
      route([VERCEL, DIRECT], pi({ model: 'gemini-3.8-flash' })),
    ],
    [
      'route: opencode with effort on vercel alone',
      route([VERCEL], opencode({ model: 'anthropic/m', effort: 'high' })),
    ],
    [
      'route: goose with effort on vercel alone',
      route([VERCEL], goose({ model: 'm', effort: 'high' })),
    ],
    [
      'route: grok build with effort on vercel alone',
      route([VERCEL], grokBuild({ model: 'm', effort: 'high' })),
    ],
    [
      'route: claude code with effort on vercel',
      route([VERCEL], claudeCode({ model: 'm', effort: 'high' })),
    ],
    [
      'route: opencode with an unknown provider on direct alone',
      route([DIRECT], opencode({ model: 'nope/m' })),
    ],
    [
      'route: opencode with an unknown provider on vercel',
      route([VERCEL], opencode({ model: 'nope/m' })),
    ],
    [
      'ts: openrouter with fallbacks',
      config({ gateway: [{ kind: 'openrouter', fallbacks: true }] }),
    ],
    [
      'ts: openrouter fallbacks not a boolean',
      config({ gateway: [{ kind: 'openrouter', fallbacks: 'yes' }] }),
    ],
    ['ts: openrouter with a typo', config({ gateway: [{ kind: 'openrouter', fallback: true }] })],
    [
      'yaml: openrouter with fallbacks',
      yaml('gateway: [{ openrouter: { fallbacks: true } }, direct]\n'),
    ],
    ['route: cursor on openrouter alone', route([OPENROUTER], cursor({ model: 'composer-2.5' }))],
    ['route: antigravity on openrouter alone', route([OPENROUTER], antigravity({ model: 'm' }))],
    ['route: fx on openrouter alone', route([OPENROUTER], fx({ model: 'gpt-5.5' }))],
    ['route: pi on openrouter alone', route([OPENROUTER], pi({ model: 'gemini-3.8-flash' }))],
    ['route: claude code on openrouter', route([OPENROUTER], claudeCode({ model: 'm' }))],
    ['route: opencode on openrouter', route([OPENROUTER], opencode({ model: 'anthropic/m' }))],
    [
      'route: codex with effort on openrouter',
      route([OPENROUTER], codex({ model: 'm', effort: 'high' })),
    ],
    [
      'route: claude code with effort on openrouter alone',
      route([OPENROUTER], claudeCode({ model: 'm', effort: 'high' })),
    ],
    [
      'route: goose with effort falls through to direct',
      route([OPENROUTER, DIRECT], goose({ model: 'gemini-3.8-flash', effort: 'high' })),
    ],
    ['oidc: expired', oidc({ VERCEL_OIDC_TOKEN: jwt(Date.parse('2026-01-01T00:00:00Z')) })],
    ['oidc: live', oidc({ VERCEL_OIDC_TOKEN: jwt(Date.parse('2026-01-01T13:00:00Z')) })],
    [
      'oidc: expired but a key is set',
      oidc({ AI_GATEWAY_API_KEY: 'k', VERCEL_OIDC_TOKEN: jwt(Date.parse('2026-01-01T00:00:00Z')) }),
    ],
    ['oidc: not a JWT', oidc({ VERCEL_OIDC_TOKEN: 'opaque' })],
    ['judge: a pin not a name', config({ judge: { model: 'anthropic/m', gateway: 'vercell' } })],
    [
      'judge: a helper pin',
      config({ judge: { model: 'anthropic/m', gateway: { kind: 'vercel' } }, gateway: [VERCEL] }),
    ],
    ['judge: an eval pin not a name', options({ judge: { gateway: 3 } })],
    ['model: mistral on direct alone', model('mistral/large', undefined, [DIRECT])],
    ['model: mistral on vercel then direct', model('mistral/large', undefined, [VERCEL, DIRECT])],
    ['model: pinned to vercel, not listed', model('anthropic/m', 'vercel', [DIRECT])],
    ['model: mistral pinned to direct', model('mistral/large', 'direct', [VERCEL, DIRECT])],
  ],
  declaration: [
    ['not a list', tree({ type: 'eval' })],
    ['a node that is not one', tree(['e'])],
    ['an unknown node type', tree([evalNode({ type: 'test' })])],
    ['a node without a type', tree([{ name: 'e' }])],
    ['an eval without a body', tree([{ type: 'eval', name: 'e', mode: 'run', options: {} }])],
    ['an eval with a bad mode', tree([evalNode({ mode: 'focus' })])],
    ['an eval with an unknown key', tree([evalNode({ timeout: '1m' })])],
    ['an eval whose options are a list', tree([evalNode({ options: [] })])],
    ['an eval whose name is a number', tree([evalNode({ name: 3 })])],
    ['a family without its cases', tree([evalNode({ family: { name: 'e', case: 0 } })])],
    [
      'a family with a fractional case',
      tree([evalNode({ family: { name: 'e', case: 0.5, cases: 2 } })]),
    ],
    [
      'a nested eval with a typo',
      tree([
        {
          type: 'group',
          name: 'g',
          mode: 'run',
          options: {},
          children: [evalNode(), evalNode({ bdy: 'b2' })],
        },
      ]),
    ],
    ['a group without children', tree([{ type: 'group', name: 'g', mode: 'run', options: {} }])],
    ['a todo with options', tree([{ type: 'todo', name: 't', options: {} }])],
    [
      'good',
      tree([
        { type: 'group', name: 'g', mode: 'skip', options: { runs: 2 }, children: [evalNode()] },
        evalNode({ family: { name: 'case %#', case: 1, cases: 2 } }),
        { type: 'todo', name: 'later' },
      ]),
    ],
  ],
  lifecycle: [
    ['start without its attempt', start({ attempt: undefined })],
    ['start with run 0', start({ attempt: { id: 'a1b2', cell, n: 0 } })],
    ['start with a cell typo', start({ attempt: { id: 'a', cell: { ...cell, rol: 'x' }, n: 1 } })],
    [
      'start with an unknown role',
      start({ attempt: { id: 'a', cell: { ...cell, role: 'arm' }, n: 1 } }),
    ],
    ['start with an empty body', start({ body: '' })],
    [
      'abort with an unknown reason',
      lifecycle(attemptAbortProblem, { type: 'abort', reason: 'oom', message: 'x' }),
    ],
    [
      'abort without a message',
      lifecycle(attemptAbortProblem, { type: 'abort', reason: 'timeout' }),
    ],
    ['done with a string error', lifecycle(attemptDoneProblem, { type: 'done', error: 'boom' })],
    [
      'done with an error without a message',
      lifecycle(attemptDoneProblem, { type: 'done', error: { name: 'Error' } }),
    ],
    [
      'done with a typo',
      lifecycle(attemptDoneProblem, { type: 'done', eror: { name: 'E', message: 'm' } }),
    ],
    ['good: start', start()],
    [
      'good: start for a variant',
      start({
        attempt: { id: 'a', cell: { ...cell, role: 'variant', variant: 'with-skill' }, n: 2 },
      }),
    ],
    [
      'good: abort',
      lifecycle(attemptAbortProblem, {
        type: 'abort',
        reason: 'timeout',
        message: 'Eval timed out after 600s',
      }),
    ],
    ['good: done', lifecycle(attemptDoneProblem, { type: 'done' })],
    [
      'good: done with an error',
      lifecycle(attemptDoneProblem, {
        type: 'done',
        error: { name: 'AssertionError', message: 'expected 1 to be 2', stack: 'at …' },
      }),
    ],
  ],
  protocol: [
    ['an empty id', request({ op: 'send', prompt: 'hi' }, '')],
    ['an unknown op', request({ op: 'teleport', to: 'mars' })],
    [
      'record with a status that is neither pass nor fail',
      request({ op: 'record', matcher: 'assert', status: 'skipped' }),
    ],
    [
      'record with a matcher that is not a name',
      request({ op: 'record', matcher: 'my check', status: 'pass' }),
    ],
    [
      'a polled exec with the result it already has',
      request({
        op: 'expect',
        subject: { exec: 'test -f a', result: { exitCode: 1, stdout: '', stderr: '' } },
        matcher: 'toSucceed',
        args: [],
        not: false,
        soft: false,
        poll: { timeout: 1000 },
      }),
    ],
    [
      'a polled call with a pattern the runner answers',
      request({
        op: 'expect',
        subject: { attempt: true },
        matcher: 'toHaveFile',
        args: ['ready.txt', { matchedBy: "re.compile('ok')", answers: {} }],
        not: false,
        soft: false,
        poll: { timeout: 1000 },
      }),
    ],
    [
      'an exec result with a fractional exit code',
      request({
        op: 'expect',
        subject: { exec: 'true', result: { exitCode: 0.5, stdout: '', stderr: '' } },
        matcher: 'toSucceed',
        args: [],
        not: false,
        soft: false,
      }),
    ],
    ['judge without a question', request({ op: 'judge' })],
    ['judge with an empty question', request({ op: 'judge', question: ' ' })],
    [
      'judge with a model without a provider',
      request({ op: 'judge', question: 'ok?', options: { model: 'jev' } }),
    ],
    [
      'judge with a fake score function',
      request({ op: 'judge', question: 'ok?', options: { model: { kind: 'fake-judge' } } }),
    ],
    [
      'judge with a threshold above 1',
      request({ op: 'judge', question: 'ok?', options: { threshold: 2 } }),
    ],
    [
      'judge with a state typo',
      request({ op: 'judge', question: 'ok?', options: { state: { transcrpt: true } } }),
    ],
    [
      'judge on a turn that is not an index',
      request({ op: 'judge', question: 'ok?', options: { on: { turn: -1 } } }),
    ],
    [
      'judge with an empty artifact name',
      request({ op: 'judge', question: 'ok?', options: { artifacts: [''] } }),
    ],
    [
      'judge with artifacts false',
      request({ op: 'judge', question: 'ok?', options: { artifacts: false } }),
    ],
    [
      'good: judge with every artifact',
      request({ op: 'judge', question: 'ok?', options: { artifacts: true } }),
    ],
    [
      'judge with a capture missing its file',
      request({
        op: 'judge',
        question: 'ok?',
        options: { artifacts: [{ name: 'home', port: 3000, path: '/', viewport: 'full-page' }] },
      }),
    ],
    [
      'judge with a capture viewport that is not whole',
      request({
        op: 'judge',
        question: 'ok?',
        options: {
          artifacts: [
            {
              name: 'home',
              port: 3000,
              path: '/',
              viewport: { width: 10.5, height: 10 },
              file: { path: 'artifacts/home.png', sha256: 'ab', bytes: 10 },
            },
          ],
        },
      }),
    ],
    ['send without a prompt', request({ op: 'send' })],
    ['exec with a typo', request({ op: 'exec', cmd: 'ls' })],
    ['exec with an empty command', request({ op: 'exec', command: '' })],
    ['exec with negative retries', request({ op: 'exec', command: 'npm test', retries: -1 })],
    ['exec with fractional retries', request({ op: 'exec', command: 'npm test', retries: 1.5 })],
    ['exec with retries as a string', request({ op: 'exec', command: 'npm test', retries: '2' })],
    ['exec with a negative interval', request({ op: 'exec', command: 'npm test', interval: -5 })],
    [
      'exec with retries in the background',
      request({ op: 'exec', command: 'npm start', background: true, retries: 2 }),
    ],
    [
      'exec with an interval in the background',
      request({ op: 'exec', command: 'npm start', background: true, interval: 100 }),
    ],
    [
      'good: exec with retries and an interval',
      request({ op: 'exec', command: 'npm test', retries: 2, interval: 0 }),
    ],
    ['c.exec with negative retries', execOptions({ retries: -1 })],
    ['c.exec with fractional retries', execOptions({ retries: 0.5 })],
    ['c.exec with infinite retries', execOptions({ retries: Number.POSITIVE_INFINITY })],
    ['c.exec with an interval as a duration string', execOptions({ interval: '1s' })],
    ['c.exec with a retry typo', execOptions({ retry: 2 })],
    ['c.exec with retries in the background', execOptions({ background: true, retries: 1 })],
    ['good: c.exec with retries', execOptions({ retries: 3, interval: 250 })],
    ['good: c.exec in the background', execOptions({ background: true })],
    ['readFile with a number', request({ op: 'readFile', path: 3 })],
    [
      'writeFile with a bad encoding',
      request({ op: 'writeFile', path: 'a', contents: 'YQ==', encoding: 'hex' }),
    ],
    ['expect with a dotted matcher', request(expectCall({ matcher: 'not.toBe' }))],
    ['expect without not', request(expectCall({ not: undefined }))],
    ['expect with a bad subject', request(expectCall({ subject: { turm: 0 } }))],
    [
      'expect with a bad pattern flag',
      request(expectCall({ args: [{ regexp: 'a', flags: 'x' }] })),
    ],
    ['expect with a label that is a number', request(expectCall({ label: 3 }))],
    [
      'exec in the background with a string',
      request({ op: 'exec', command: 'ls', background: 'yes' }),
    ],
    ['serve on port 0', request({ op: 'serve', command: 'npm start', port: 0 })],
    ['serve on a port above 65535', request({ op: 'serve', command: 'npm start', port: 70000 })],
    ['kill without a handle', request({ op: 'kill' })],
    ['capture without a target', request({ op: 'capture' })],
    ['capture on a host', request({ op: 'capture', target: { host: 'localhost' } })],
    [
      'capture with a viewport typo',
      request({ op: 'capture', target: { port: 3000 }, options: { viewport: 'fullpage' } }),
    ],
    [
      'capture with a negative wait',
      request({ op: 'capture', target: { port: 3000 }, options: { wait: { ms: -1 } } }),
    ],
    [
      'poll on a value',
      request(expectCall({ subject: { value: 1 }, matcher: 'toBe', args: [1], poll: {} })),
    ],
    ['poll with a zero interval', request(expectCall({ poll: { interval: 0 } }))],
    ['poll with a typo', request(expectCall({ poll: { timout: 5000 } }))],
    ['good: send', request({ op: 'send', prompt: 'Write greet.js.' })],
    ['good: judge', request({ op: 'judge', question: 'Does greet.js export greet?' })],
    [
      'good: judge with options',
      request({
        op: 'judge',
        question: 'Does the page show a greeting?',
        options: {
          model: 'google/gemini-3.8-flash',
          threshold: 0.7,
          providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
          state: { transcript: 'tools', turns: 'all', checks: ['npm test'] },
          on: { turn: 0 },
          artifacts: [
            'home',
            {
              name: 'about',
              port: 3000,
              path: '/about',
              viewport: { width: 1280, height: 720 },
              file: { path: 'artifacts/about.png', sha256: 'ab', bytes: 10 },
            },
          ],
        },
      }),
    ],
    [
      'good: judge on a value with a fake judge',
      request({
        op: 'judge',
        question: 'Is it polite?',
        options: { model: { kind: 'fake-judge', score: 0.9 }, on: { value: { text: 'Hi' } } },
      }),
    ],
    ['good: exec', request({ op: 'exec', command: 'node greet.js' })],
    [
      'good: exec in the background',
      request({ op: 'exec', command: 'npm run watch', background: true }),
    ],
    ['good: serve', request({ op: 'serve', command: 'npm start', port: 3000 })],
    ['good: serve on any port', request({ op: 'serve', command: 'npx serve -l $PORT' })],
    ['good: kill', request({ op: 'kill', handle: 'h1' })],
    ['good: capture on a port', request({ op: 'capture', target: { port: 3000 } })],
    [
      'good: capture on a serve handle',
      request({
        op: 'capture',
        target: { handle: 'h1' },
        options: {
          name: 'about',
          path: '/about',
          viewport: 'full-page',
          timeout: '30s',
          wait: 'idle',
          instructions: ['Open the menu', { wait: { ms: 500 } }, 'Click About'],
          model: 'google/gemini-3.8-flash',
        },
      }),
    ],
    [
      'good: poll a command',
      request(
        expectCall({
          subject: { exec: 'curl -s localhost:3000' },
          matcher: 'toSucceed',
          args: [],
          poll: { interval: 200, timeout: 10000 },
        }),
      ),
    ],
    [
      'good: poll a file',
      request(
        expectCall({
          subject: { readFile: 'out.log' },
          matcher: 'toContain',
          args: ['ready'],
          poll: {},
        }),
      ),
    ],
    ['good: readFile', request({ op: 'readFile', path: '~/notes.md' })],
    [
      'good: writeFile',
      request({ op: 'writeFile', path: 'a.bin', contents: 'AAE=', encoding: 'base64' }),
    ],
    [
      'good: expect',
      request(
        expectCall({
          subject: { turn: 0 },
          matcher: 'toHaveRun',
          args: [{ regexp: '^npm (test|t)$', flags: 'i' }],
          not: true,
          soft: true,
          label: 'never runs the tests',
        }),
      ),
    ],
    [
      'good: expect on a value',
      request(
        expectCall({
          subject: { value: { exitCode: 0, stdout: '', stderr: '' } },
          matcher: 'toSucceed',
          args: [],
        }),
      ),
    ],
  ],
}
