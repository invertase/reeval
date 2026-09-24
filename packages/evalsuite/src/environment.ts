import { fileURLToPath } from 'node:url'
import type { Environment, EnvironmentStep, McpServer, Secret, SkillOptions } from './types.ts'

export class DefinitionError extends Error {
  override name = 'DefinitionError'
}

export interface EnvironmentBuilder {
  /** Inlines another environment's steps, in order. */
  use(other: Environment): void
  /**
   * Runs a shell command. By default it's baked into a cached image layer, where secrets don't
   * exist; `{ cache: false }` runs it in every fresh sandbox instead, with secrets set.
   */
  exec(command: string, options?: { cache?: boolean }): void
  /**
   * A skill directory (with a `SKILL.md`), a directory of them, or a git URL. Paths are relative to
   * the project root; pass a `URL` for one relative to your file.
   */
  skill(source: string | URL, options?: SkillOptions): void
  /** An MCP server: a command line, `{ command, args, env }`, or `{ url, headers }`. */
  mcp(name: string, server: string | McpServer): void
  /** `AGENTS.md` for the workspace: markdown, or the path of a `.md` file. */
  rules(markdownOrPath: string | URL): void
  /** Writes a file into the workspace, or the home directory for a `~/` path. */
  file(path: string, content: string | { from: string | URL }): void
  var(name: string, value: string): void
  /** Passes host variable `from` (default: `name`) into the sandbox as `name`, redacted. */
  secret(name: string, from?: string): void
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/

const toPath = (value: string | URL) => (value instanceof URL ? fileURLToPath(value) : value)

/** `$NAME` or `${NAME}` for any of `names`. */
export function referencedSecret(command: string, names: string[]): string | undefined {
  return names.find((n) => new RegExp(`\\$(?:\\{${n}\\}|${n}(?![A-Za-z0-9_]))`).test(command))
}

/**
 * Defines what an eval's sandbox gets before the agent starts: skills, MCP servers, rules, files,
 * installed tools and variables. Use a list of environments as a matrix axis, e.g.
 * `environment: [baseline, withSkill]`.
 */
export function defineEnvironment(
  name: string,
  build: (env: EnvironmentBuilder) => void,
): Environment {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new DefinitionError(
      `defineEnvironment needs a name of letters, digits, ".", "_", "@" or "-" (got ${JSON.stringify(name)})`,
    )
  }
  const steps: EnvironmentStep[] = []
  const secrets = () => steps.flatMap((s) => (s.kind === 'secret' ? [s.name] : []))
  const checkVar = (method: string, v: string) => {
    if (!VAR.test(v))
      throw new DefinitionError(
        `env.${method}("${v}") in environment ${name}: not a valid variable name`,
      )
  }
  const env: EnvironmentBuilder = {
    use(other) {
      if (other?.kind !== 'environment') {
        throw new DefinitionError(
          `env.use() in environment ${name} needs an environment from defineEnvironment()`,
        )
      }
      steps.push(...other.steps)
    },
    exec(command, options = {}) {
      const cache = options.cache ?? true
      const secret = cache ? referencedSecret(command, secrets()) : undefined
      if (secret) {
        throw new DefinitionError(
          `env.exec(${JSON.stringify(command)}) in environment ${name} references the secret ${secret}, ` +
            'but cached steps are baked into an image and never see secrets. ' +
            'Pass { cache: false } to run it in each sandbox instead.',
        )
      }
      steps.push({ kind: 'exec', command, cache })
    },
    skill(source, options = {}) {
      steps.push({ kind: 'skill', source: toPath(source), options: { ...options } })
    },
    mcp(serverName, server) {
      if (typeof server === 'string') {
        const [command, ...args] = server.trim().split(/\s+/)
        if (!command)
          throw new DefinitionError(
            `env.mcp("${serverName}") in environment ${name} needs a command`,
          )
        steps.push({ kind: 'mcp', name: serverName, server: { command, args } })
      } else {
        steps.push({ kind: 'mcp', name: serverName, server: structuredClone(server) })
      }
    },
    rules(markdownOrPath) {
      const value = toPath(markdownOrPath)
      const isFile = /\.md$/i.test(value) && !value.includes('\n')
      steps.push(
        isFile
          ? { kind: 'file', path: 'AGENTS.md', from: value }
          : { kind: 'rules', content: value },
      )
    },
    file(path, content) {
      steps.push(
        typeof content === 'string'
          ? { kind: 'file', path, content }
          : { kind: 'file', path, from: toPath(content.from) },
      )
    },
    var(varName, value) {
      checkVar('var', varName)
      steps.push({ kind: 'var', name: varName, value: String(value) })
    },
    secret(varName, from = varName) {
      checkVar('secret', varName)
      checkVar('secret', from)
      steps.push({ kind: 'secret', name: varName, from })
    },
  }
  build(env)
  return Object.freeze({ kind: 'environment', name, steps: Object.freeze(steps) })
}

/** The empty environment: the control that treatments are compared against. */
export const baseline: Environment = defineEnvironment('baseline', () => {})

/** Passes host variable `from` (default: the key it's set under) into the sandbox, redacted. */
export const secret = (from?: string): Secret =>
  from ? { kind: 'secret', from } : { kind: 'secret' }

export const isSecret = (value: unknown): value is Secret =>
  typeof value === 'object' && value !== null && (value as Secret).kind === 'secret'
