// What an attempt's debug trace says about its plan and environment. The lines name secrets,
// never their values; the payloads leave values out too, and are redacted besides.
import type { EndpointMatch } from '@reeval/sandbox-docker'
import type { AttemptDebug } from '../debug/attempt.ts'
import { egressLabel } from '../egress.ts'
import type { ResolvedEnvironment } from '../environment/resolve.ts'
import { brokeringFor } from '../harness/agents.ts'
import { harnessId, sandboxId } from '../options.ts'
import { formatDuration } from '../text.ts'
import type { RunContext } from '../types.ts'
import type { AttemptSpec } from './state.ts'

/** Which config and profile the attempt runs under, and where each resolved option came from. */
export function tracePlan(debug: AttemptDebug, spec: AttemptSpec, ctx: RunContext): void {
  const config = ctx.configFile ?? 'none (no config file found)'
  const from = (key: string, fallback = ctx.configFile ? `${config} or its default` : 'default') =>
    `(${spec.sources[key] ?? fallback})`
  const profile = ctx.profile ? `profile ${ctx.profile.name} (${ctx.profile.reason})` : 'no profile'
  debug.log(
    'plan',
    `config ${config} · ${profile} · run ${ctx.runId} · attempt ${spec.cell.key}#${spec.n}`,
  )
  debug.log('plan', `harness ${harnessId(spec.harness)} ${from('harnesses')}`)
  debug.log('plan', `sandbox ${sandboxId(spec.sandbox)} ${from('sandbox')}`)
  const env = spec.environment
  const role = spec.cell.role === 'variant' ? ` · variant ${spec.cell.variant}` : ''
  const envFrom = spec.cell.role === 'variant' ? from('compare') : from('environments', 'none set')
  debug.log('plan', `environment ${env.name}${role} ${envFrom}`)
  debug.log('plan', `egress ${egressLabel(spec.egress) || 'proxy'} ${from('egress')}`)
  const gate = typeof spec.gate === 'string' ? spec.gate : `passRate ${spec.gate.passRate}`
  debug.log(
    'plan',
    `run ${spec.n} · runs ${ctx.runs !== undefined ? '(--runs)' : from('runs')} · gate ${gate} · timeout ${formatDuration(spec.timeoutMs)} ${from('timeout', 'config.timeout or 15m')}`,
  )
  const judge = spec.judge
  const model =
    typeof judge.model === 'string'
      ? judge.model
      : judge.model && 'kind' in judge.model
        ? 'fake judge'
        : judge.model
          ? 'a model object'
          : 'none'
  debug.log(
    'plan',
    `judge ${model}${judge.threshold !== undefined ? ` · threshold ${judge.threshold}` : ''} ${from('judge')}`,
  )
  for (const note of spec.notes) debug.log('plan', `profile: ${note}`)
  debug.trace('plan', 'config', { config: ctx.config, profile: ctx.profile }, 'resolved config')
  debug.trace(
    'plan',
    'attempt',
    {
      cell: spec.cell,
      n: spec.n,
      harness: spec.harness,
      sandbox: spec.sandbox,
      egress: spec.egress,
      gate: spec.gate,
      timeoutMs: spec.timeoutMs,
      judge: spec.judge,
      sources: spec.sources,
      env: Object.keys(spec.env).sort(),
    },
    'resolved attempt',
  )
}

/** `POST api2.cursor.sh/auth/exchange`, `GET host/v1/*` or `POST host (path ~ /re/)`. */
function endpointLabel({ method, host, path }: EndpointMatch): string {
  const where = !path
    ? host
    : 'exact' in path
      ? `${host}${path.exact}`
      : 'startsWith' in path
        ? `${host}${path.startsWith}*`
        : `${host} (path ~ /${path.regex}/)`
  return `${method?.join('|') ?? '*'} ${where}`
}

/** The resolved environment and what the gateway brokers, by name. */
export function traceEnvironment(
  debug: AttemptDebug,
  spec: AttemptSpec,
  env: ResolvedEnvironment,
): void {
  const r = env.record
  debug.log(
    'env',
    `environment ${r.name} (digest ${r.digest.replace(/^sha256:/, '').slice(0, 12)})${r.parent ? ` · extends ${r.parent}` : ''}${r.overrides.length ? ` · overrides ${r.overrides.join(', ')}` : ''}`,
  )
  const unset = r.unset.length ? ` · unset (optional) ${r.unset.join(', ')}` : ''
  debug.log(
    'env',
    `vars ${r.vars.join(', ') || 'none'} · secrets ${r.secrets.join(', ') || 'none'}${unset}`,
  )
  for (const s of env.substitutions) {
    debug.log(
      'broker',
      `${s.name} is a placeholder in the sandbox · swapped in on HTTPS to ${s.hosts.join(', ')} in the ${s.in.join(', ')} · for ${s.phase === 'checks' ? 'checks and setup only' : 'the agent and checks'}`,
    )
  }
  const brokering = brokeringFor(spec.harness, spec.vertex)
  if (brokering) {
    const endpoints = brokering.endpoints.map(endpointLabel).join(', ')
    debug.log(
      'broker',
      `${brokering.credential} stays on the host · the gateway swaps it in on ${endpoints}`,
    )
  }
  debug.trace(
    'env',
    'environment',
    {
      record: r,
      vars: Object.keys(env.vars).sort(),
      checkVars: Object.keys(env.checkVars).sort(),
      files: env.files.map((f) => f.path),
      setup: env.setup,
      skills: env.skills.map((s) => s.name),
      workspaceSkills: env.workspaceSkills.map((s) => s.name),
      plugins: env.plugins.map((p) => ({ name: p.name, parts: p.parts, files: p.files.length })),
      mcp: Object.fromEntries(
        Object.entries(env.mcp).map(([name, m]) => [
          name,
          m.transport === 'stdio'
            ? { transport: m.transport, command: m.command, args: m.args, env: Object.keys(m.env) }
            : { transport: m.transport, url: m.url, headers: Object.keys(m.headers) },
        ]),
      ),
      brokered: env.substitutions.map(({ name, hosts, in: where, phase }) => ({
        name,
        hosts,
        in: where,
        phase,
      })),
    },
    'resolved environment',
  )
}
