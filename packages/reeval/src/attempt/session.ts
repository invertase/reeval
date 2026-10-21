import { readFile } from 'node:fs/promises'
import { shellQuote } from '@reeval/sandbox-docker/process'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { snapshot } from '../diff.ts'
import {
  PLUGIN_DIR,
  MANIFEST as PLUGIN_MANIFEST,
  PLUGIN_ROOT,
  PLUGIN_ROOT_VAR,
} from '../environment/plugins.ts'
import { type ResolvedEnvironment, type ResolvedStep, skillFiles } from '../environment/resolve.ts'
import { brokeringFor, claudeMcpServers, expectedBlockedFor } from '../harness/agents.ts'
import { createHarness, layoutOf, workspaceSkillDir } from '../harness/index.ts'
import type { Harness, HarnessSession, Treatments } from '../harness/types.ts'
import { harnessId } from '../options.ts'
import { createSandbox, InfraError, type Sandbox } from '../sandbox/index.ts'
import { brokerPhases } from '../sandbox/phases.ts'
import { clip, formatDuration } from '../text.ts'
import { asCheck } from './checks.ts'
import { timeMcpServers } from './mcp-startup.ts'
import { type Attempt, setupAllowance, startTimeoutMs } from './state.ts'

const tailOf = (text: string) => text.trim().split('\n').slice(-10).join('\n')

/** Setup steps in order, each with its own timeout; a failure is an infra error. */
async function runSetup(a: Attempt, box: Sandbox, env: ResolvedEnvironment) {
  const { record, spec } = a
  const steps: ResolvedStep[] = env.setup
  record.setup = []
  for (const [i, step] of steps.entries()) {
    const what = `setup step ${i + 1}/${steps.length} "${clip(step.run, 80)}" in environment ${spec.environment.name}`
    const start = performance.now()
    const stepSignal = AbortSignal.any([a.signal, AbortSignal.timeout(step.timeoutMs)])
    const r = await asCheck(a, () =>
      box.exec(step.run, {
        signal: stepSignal,
        env: env.checkVars,
        ...(step.cwd ? { cwd: step.cwd } : {}),
      }),
    ).catch((error) => {
      if (a.signal.aborted) throw error
      if (!stepSignal.aborted) {
        throw new InfraError(
          `${what} couldn't run: ${error instanceof Error ? error.message : error}`,
        )
      }
      return null
    })
    const durationMs = Math.round(performance.now() - start)
    const output = r ? [r.stdout, r.stderr].filter(Boolean).join('\n') : ''
    record.setup.push({ run: step.run, exitCode: r?.exitCode ?? null, durationMs, output })
    debugLog(
      'env',
      `setup ${i + 1}/${steps.length} $ ${clip(step.run, 120)} → ${r ? `exit ${r.exitCode}` : `timed out after ${formatDuration(step.timeoutMs)}`} · ${formatDuration(durationMs)}${step.cwd ? ` · in ${step.cwd}` : ''}`,
    )
    debugTrace(
      'env',
      'setup',
      {
        run: step.run,
        cwd: step.cwd,
        exitCode: r?.exitCode ?? null,
        durationMs,
        stdout: r?.stdout,
        stderr: r?.stderr,
      },
      `setup ${i + 1} output`,
    )
    if (r?.exitCode === 0) continue
    throw new InfraError(
      r
        ? `${what} exited ${r.exitCode} after ${formatDuration(durationMs)} (see setup.log):\n${tailOf(r.stderr || r.stdout)}`
        : `${what} timed out after ${formatDuration(step.timeoutMs)} (see setup.log)`,
    )
  }
}

// A relative path: GNU tar (Git for Windows' too) reads a `C:` in its file name as a remote host.
const WORKSPACE_TAR = '.reeval-workspace.tar'

/** Unpacks the git workspace's tarball into the (empty) workspace. */
async function copyWorkspace(
  box: Sandbox,
  workspace: NonNullable<ResolvedEnvironment['workspace']>,
  signal: AbortSignal,
) {
  const start = performance.now()
  const tar = await readFile(workspace.tar)
  await box.writeFile(WORKSPACE_TAR, tar)
  const r = await box.exec(`tar -xf ${WORKSPACE_TAR} && rm -f ${WORKSPACE_TAR}`, { signal })
  if (r.exitCode !== 0) {
    throw new InfraError(
      `Couldn't unpack the workspace ${workspace.label} into the sandbox (the image needs tar): ${tailOf(r.stderr || r.stdout)}`,
    )
  }
  if (workspace.init) {
    // A fixed author and date, so every attempt's HEAD is the same commit of the same tree.
    const at = '2000-01-01T00:00:00Z'
    const init = await box.exec(
      `git init -q -b main && git add -A && git -c commit.gpgsign=false commit -q --no-verify -m ${shellQuote(`${workspace.label} at ${workspace.commit}`)}`,
      {
        signal,
        env: {
          GIT_AUTHOR_NAME: 'reeval',
          GIT_AUTHOR_EMAIL: 'reeval@localhost',
          GIT_AUTHOR_DATE: at,
          GIT_COMMITTER_NAME: 'reeval',
          GIT_COMMITTER_EMAIL: 'reeval@localhost',
          GIT_COMMITTER_DATE: at,
        },
      },
    )
    if (init.exitCode !== 0) {
      throw new InfraError(
        `Couldn't give the workspace ${workspace.label} a .git (init: true needs git in the image): ${tailOf(init.stderr || init.stdout)}`,
      )
    }
  }
  debugLog(
    'env',
    `workspace ${workspace.label} at ${workspace.commit.slice(0, 12)} (${tar.byteLength} bytes of tar${workspace.init ? ', with a .git' : ''}) in ${formatDuration(performance.now() - start)}`,
  )
}

/**
 * Copies each plugin to `PLUGIN_DIR/<name>/` before the workspace snapshot, and points its MCP
 * servers' `${CLAUDE_PLUGIN_ROOT}` at that directory, for the adapter to load from there.
 */
async function copyPlugins(a: Attempt, box: Sandbox, env: ResolvedEnvironment) {
  const out: Treatments['plugins'] = []
  for (const plugin of env.plugins) {
    const at = `${PLUGIN_DIR}/${plugin.name}`
    const dir = `${box.home}/${at.slice(2)}`
    for (const f of plugin.files) await box.writeFile(`${at}/${f.path}`, f.content)
    const executable = plugin.files.flatMap((f) => (f.executable ? [`${dir}/${f.path}`] : []))
    if (executable.length) {
      const r = await box.exec(`chmod +x ${executable.map(shellQuote).join(' ')}`, {
        signal: a.signal,
      })
      if (r.exitCode !== 0) {
        throw new InfraError(
          `Couldn't make the ${plugin.name} plugin's ${executable.length} executable files executable: ${tailOf(r.stderr || r.stdout)}`,
        )
      }
    }
    const root = (v: string) => v.replaceAll(PLUGIN_ROOT, dir)
    for (const key of plugin.servers) {
      const server = env.mcp[key]
      if (server?.transport !== 'stdio') continue
      env.mcp[key] = {
        ...server,
        command: root(server.command),
        args: server.args.map(root),
        env: {
          ...Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, root(v)])),
          [PLUGIN_ROOT_VAR]: dir,
        },
      }
    }
    out.push({ name: plugin.name, dir, parts: plugin.parts, servers: plugin.servers })
    debugLog(
      'env',
      `plugin ${plugin.name} → ${at}/ (${plugin.files.length} files; ${plugin.parts.join(', ')})`,
    )
  }
  return out
}

/**
 * For an agent that starts a plugin's MCP servers from the plugin itself: rewrites each placed
 * plugin's `.mcp.json` to the servers as reeval resolved them, through the MCP timer, so they're
 * timed like the environment's. A manifest that declares `mcpServers` is pointed at that file.
 * Only namespaced layouts, which refuse a plugin server reading a host secret, so no secret value
 * lands in the file.
 */
async function writePluginMcp(
  box: Sandbox,
  env: ResolvedEnvironment,
  plugins: Treatments['plugins'],
  servers: Treatments['mcp'],
) {
  for (const placed of plugins) {
    if (!placed.servers.length) continue
    const own = Object.fromEntries(
      placed.servers.flatMap((key) => {
        const s = servers[key]
        return s ? [[key.slice(placed.name.length + 1), s]] : []
      }),
    )
    const at = `${PLUGIN_DIR}/${placed.name}`
    const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
    await box.writeFile(`${at}/.mcp.json`, json({ mcpServers: claudeMcpServers(own) }))
    const manifest = env.plugins
      .find((p) => p.name === placed.name)
      ?.files.find((f) => f.path === PLUGIN_MANIFEST)
    const parsed = manifest ? JSON.parse(Buffer.from(manifest.content).toString('utf8')) : {}
    if (parsed.mcpServers !== undefined) {
      await box.writeFile(
        `${at}/${PLUGIN_MANIFEST}`,
        json({ ...parsed, mcpServers: './.mcp.json' }),
      )
    }
    debugLog('env', `plugin ${placed.name}'s MCP servers → ${at}/.mcp.json, through the timer`)
  }
}

/**
 * Starts the harness session within its `startTimeout`. A start that doesn't become ready in time
 * is aborted (and closed, should it finish later) and started once more: a stuck bootstrap is
 * usually transient, and nothing has run yet, so the retry can't change what the attempt
 * measures. A second timeout is an infra error; a start that fails outright isn't retried.
 */
async function startHarness(
  a: Attempt,
  harness: Harness,
  box: Sandbox,
  options: Parameters<Harness['start']>[2],
): Promise<HarnessSession> {
  const { harness: descriptor } = a.spec
  const ms = startTimeoutMs(descriptor)
  const late = `${descriptor.kind}: session did not become ready within ${formatDuration(ms)}`
  for (let tries = 1; ; tries++) {
    const stop = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    })
    const starting = harness.start(box, AbortSignal.any([a.signal, stop.signal]), options)
    const session = await Promise.race([starting, timedOut]).finally(() => clearTimeout(timer))
    if (session) return session
    stop.abort(new InfraError(late))
    starting.then(
      (s) => s.close().catch(() => {}),
      () => {},
    )
    a.signal.throwIfAborted()
    if (tries === 2) throw new InfraError(`${late} (tried twice)`)
    a.record.startRetries = [{ error: late, waitedMs: ms }]
    debugLog('harness', `${late}; starting it once more`)
  }
}

/**
 * Starts the sandbox (with the brokered secrets its gateway swaps in), writes the
 * environment's files, workspace skills and plugins, runs its setup steps, snapshots the workspace for
 * the diff, and starts the harness session with the harness-placed skills and MCP servers.
 */
export async function startSession(a: Attempt, runId: string): Promise<[Sandbox, HarnessSession]> {
  const startedAt = performance.now()
  const { spec } = a
  const env = a.env as ResolvedEnvironment
  const box = await createSandbox(spec.sandbox, {
    runId,
    timeoutMs: spec.timeoutMs + setupAllowance(spec) + 60_000,
    signal: a.signal,
    env: env.vars,
    image: a.image,
    brokering: brokeringFor(spec.harness),
    expectedBlocked: expectedBlockedFor(spec.harness)?.hosts,
    substitutions: env.substitutions,
    egress: spec.egress,
  })
  a.sandbox = box
  if (spec.sandbox.kind === 'fake') debugLog('container', `fake sandbox at ${box.workdir}`)
  a.phases = brokerPhases(box, env.substitutions)
  if (a.signal.aborted) void box.destroy()
  a.signal.throwIfAborted()
  await a.phases.start()
  if (env.substitutions.length) {
    const agent = env.substitutions.filter((s) => s.phase === 'agent').map((s) => s.name)
    debugLog('broker', `gateway swaps in ${agent.join(', ') || 'nothing'} for the agent`)
  }
  if (env.workspace) await copyWorkspace(box, env.workspace, a.signal)
  for (const f of env.files) {
    await box.writeFile(f.path, f.content)
    const size = typeof f.content === 'string' ? Buffer.byteLength(f.content) : f.content.byteLength
    debugLog('env', `file ${f.path} (${size} bytes${f.executable ? ', executable' : ''})`)
  }
  const executable = env.files.flatMap((f) =>
    f.executable ? [f.path.startsWith('~/') ? `${box.home}/${f.path.slice(2)}` : f.path] : [],
  )
  if (executable.length) {
    // BSD chmod (macOS, where the fake sandbox runs on the host) reads `--` after the mode as a
    // file, so a leading `-` is guarded with `./` instead.
    const paths = executable.map((p) => shellQuote(p.startsWith('-') ? `./${p}` : p))
    const r = await box.exec(`chmod +x ${paths.join(' ')}`, {
      signal: a.signal,
    })
    if (r.exitCode !== 0) {
      throw new InfraError(
        `Couldn't make ${executable.join(', ')} executable: ${tailOf(r.stderr || r.stdout)}`,
      )
    }
  }
  const skillDir = workspaceSkillDir(spec.harness)
  for (const skill of env.workspaceSkills) {
    const files = skillFiles(skill)
    for (const f of files) {
      await box.writeFile(`${skillDir}/${skill.name}/${f.path}`, f.content)
    }
    debugLog(
      'env',
      `skill ${skill.name} → ${skillDir}/${skill.name}/ (${files.length} files, workspace)`,
    )
  }
  const plugins = await copyPlugins(a, box, env)
  const layout = layoutOf(spec.harness)
  for (const skill of env.skills) {
    debugLog(
      'env',
      `skill ${skill.name} → the harness adapter places it (~/${layout.harnessSkillDir}/${skill.name}/ for ${spec.harness.kind === 'fake' ? `the fake ${spec.harness.layout ?? 'cursor'} layout` : spec.harness.kind})`,
    )
  }
  for (const [name, server] of Object.entries(env.mcp)) {
    debugLog(
      'env',
      `mcp ${name} (${server.transport}${server.transport === 'stdio' ? `: ${server.command} ${server.args.join(' ')}` : `: ${server.url}`}) → the harness adapter writes its MCP config`,
    )
  }
  await runSetup(a, box, env)
  await snapshot(box, a.signal)
  debugLog('env', 'workspace snapshot taken: the diff starts here')
  const timed = await timeMcpServers(box, env.mcp, a.signal)
  if (timed.log) {
    a.mcpStartup = timed.log
    debugLog('env', "stdio MCP servers start through reeval's MCP timer")
  } else if (timed.untimed) {
    debugLog('env', `stdio MCP servers start untimed: ${timed.untimed}`)
  }
  if (layout.pluginPlacement === 'namespaced') {
    await writePluginMcp(box, env, plugins, timed.servers)
  }
  const harness = await createHarness(spec.harness)
  const harnessStart = performance.now()
  debugLog('harness', `starting ${harnessId(spec.harness)}: bootstrap and session`)
  const session = await startHarness(a, harness, box, {
    skills: env.skills,
    workspaceSkills: env.workspaceSkills.map((s) => s.name),
    mcp: timed.servers,
    plugins,
  })
  debugLog(
    'harness',
    `${harnessId(spec.harness)} session ready in ${formatDuration(performance.now() - harnessStart)}`,
  )
  a.session = session
  const startMs = performance.now() - startedAt
  debugLog('container', `sandbox and session started in ${formatDuration(startMs)}`)
  // The environment's preparation plus this start, not the eval's own code before its first call.
  a.report({ kind: 'sandbox-ready', ms: Math.round(a.record.timings.setupMs + startMs) })
  return [box, session]
}
