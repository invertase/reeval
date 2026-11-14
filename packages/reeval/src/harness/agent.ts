import type { HarnessV1 } from '@ai-sdk/harness'
import { type AgentLog, errorText, startAgent } from '@reeval/agents'
import { WORKSPACE_DIR } from '@reeval/sandbox-docker'
import { runnerOf } from '../environment/runner.ts'
import { brokerToken } from '../environment/token.ts'
import type { SandboxAdc, VertexSettings } from '../gateway/vertex.ts'
import { capabilitiesOf, runsAgent, sandboxKind, suggestedSandbox } from '../sandbox/kinds.ts'
import { hasNetworkSession, InfraError, type Sandbox } from '../sandbox/types.ts'
import type { AgentHarnessDescriptor, SandboxDescriptor } from '../types.ts'
import {
  type AdapterVertex,
  type Agent,
  agentAuth,
  agentFor,
  agentMcp,
  authHint,
  writePluginFiles,
} from './agents.ts'
import { WORKSPACE_PATH } from './transcript.ts'
import type { Harness } from './types.ts'

/** The route's service account, written beside the workspace, as the adapter takes it. */
async function writeAdc(sandbox: Sandbox, adc: SandboxAdc, log: AgentLog): Promise<AdapterVertex> {
  await sandbox.writeFile(`../${adc.file}`, adc.content)
  const credentialsFile = `${sandbox.workdir.replace(/[\\/][^\\/]*$/, '')}/${adc.file}`
  log.log('env', `Vertex AI service account → ${credentialsFile}`)
  return { project: adc.project, location: adc.location, credentialsFile }
}

/**
 * Why `agent` can't run in `sandbox`: its kind has no harness session, can't keep the agent's
 * credential out of it, or runs a platform the agent's bootstrap has no build for.
 */
export function agentSandboxProblem(agent: Agent, sandbox: SandboxDescriptor): string | undefined {
  const fits = runsAgent(agent.platforms)
  const can = capabilitiesOf(sandbox)
  if (fits(can)) return undefined
  // Only a sandbox with a harness session runs the bootstrap, so only its platform matters.
  const lacks = [
    ...(can.harnessSession ? [] : ['has no harness session']),
    ...(can.brokers ? [] : [`can't keep ${agent.credential} out of it`]),
    ...(!can.harnessSession || agent.platforms.includes(can.platform)
      ? []
      : [`runs ${can.platform}, not ${agent.platforms.join(' or ')}`]),
  ]
  const fix = suggestedSandbox(fits)
  return `The ${agent.name} harness can't run in the ${sandboxKind(sandbox).provider(sandbox)} sandbox, which ${lacks.join(' and ')}: ${fix ? `set sandbox: ${fix} for this eval, or ` : ''}use fakeHarness() with fakeSandbox()`
}

/** A real agent through its AI SDK harness adapter, in a sandbox that gives it a harness session. */
export function createAgentHarness(
  descriptor: AgentHarnessDescriptor,
  sandbox: SandboxDescriptor,
  vertex?: VertexSettings,
): Harness {
  const catalog = agentFor(descriptor, vertex)
  const problem = agentSandboxProblem(catalog, sandbox)
  if (problem) throw new InfraError(problem)
  return {
    async start(sandbox, signal, { skills, mcp, plugins }, log) {
      const auth = agentAuth(catalog)
      const servers = agentMcp(catalog, mcp, plugins)
      const model = catalog.modelId?.(descriptor.model) ?? descriptor.model
      const vertex = catalog.adc ? await writeAdc(sandbox, catalog.adc, log) : undefined
      const adapter = await catalog.adapter({
        auth,
        ...(catalog.routeEnv ? { env: catalog.routeEnv } : {}),
        ...(vertex ? { vertex } : {}),
        ...(catalog.vertexChat ? { vertexChat: catalog.vertexChat } : {}),
        descriptor,
        model,
        plugins,
        ...(Object.keys(servers).length ? { mcpServers: catalog.mcpServers(servers) } : {}),
      })
      for (const path of await writePluginFiles(sandbox, catalog, plugins)) {
        log.log('env', `plugin settings → ${path}`)
      }
      if (!hasNetworkSession(sandbox)) {
        throw new InfraError(`The ${catalog.name} harness got a sandbox with no harness session`)
      }
      let stopToken = () => {}
      if (catalog.token) {
        try {
          stopToken = await brokerToken(catalog.token, sandbox.network, {
            onRefresh: (t) =>
              log.log(
                'broker',
                `access token refreshed, valid until ${new Date(t.expiresAt).toISOString()}`,
              ),
            onError: (error) =>
              log.log('broker', `access token refresh failed, retrying: ${errorText(error)}`),
          })
        } catch (error) {
          throw new InfraError(
            `Couldn't mint an access token from ${catalog.credential} for ${catalog.name}: ${errorText(error)}. Run gcloud auth application-default login, or set GOOGLE_APPLICATION_CREDENTIALS.`,
          )
        }
        log.log('broker', `gateway adds an access token from ${catalog.credential}`)
      }
      const { runner, session } = runnerOf(sandbox)
      return startAgent({
        kind: descriptor.kind,
        entry: catalog,
        adapter: adapter as HarnessV1,
        model,
        runner,
        session,
        workDir: WORKSPACE_DIR,
        skills,
        signal,
        log,
        traffic: {
          statuses: () => sandbox.brokeredStatuses?.() ?? [],
          servedModels: () => sandbox.servedRequests?.() ?? [],
        },
        authHint: (message, refused) => authHint(catalog, message, refused),
        workspace: WORKSPACE_PATH,
        raw: Boolean(process.env.REEVAL_RAW_TRANSCRIPT),
        onClose: stopToken,
      })
    },
  }
}
