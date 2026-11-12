import { defineEnvironment } from 'reeval'
import { docker } from 'reeval/sandbox'

/**
 * The probe server, under a policy that allows only the host's listener. The eval sets its
 * variables in `env`, never in the server's own, so they reach it only from the sandbox's.
 */
const probeEnv = (name: string, own?: Record<string, string>) =>
  defineEnvironment(name, ({ file, mcp, secret }) => ({
    sandbox: docker(),
    egress: { allow: [process.env.REEVAL_EGRESS_HOST ?? 'missing.invalid'] },
    env: {
      PROBE_WORD: 'HERON-41',
      PROBE_TARGET: process.env.REEVAL_EGRESS_TARGET ?? 'missing.invalid',
      PROBE_KEY: secret.fromEnv('REEVAL_FIXTURE_TOKEN', { hosts: ['api.example.com'] }),
    },
    files: { '~/reeval-mcp/probe.mjs': file('../probe.mjs') },
    mcp: {
      probe: mcp.stdio('node', ['/home/reeval/reeval-mcp/probe.mjs'], own ? { env: own } : {}),
    },
  }))

export const probed = probeEnv('probed')
/** The server sets a PROBE_WORD of its own, which wins over the eval's. */
export const own = probeEnv('own', { PROBE_WORD: 'OWN-9' })

export const LOG = '/tmp/reeval-fx-probe.txt'

export const prompt =
  'Call the probe tool of the probe MCP server once, and reply with what it returned.'

/** The probe's lines, or none when it was never called. */
export const probedLines = (text: string | null) => (text ?? '').split('\n').filter(Boolean)
