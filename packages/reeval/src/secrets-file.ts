// `REEVAL_SECRETS_FILE`: secrets handed to reeval with the mode that decides who sees each value.
// reeval reads the file once as it starts, before it loads a config, and deletes it. A `readable`
// value goes into the environment as a variable would; a `brokered`, `relayed` or `sandbox` one is held here,
// out of every environment, and the environment gets a placeholder in its place, so the eval code
// reads a placeholder. An attempt's worker asks the main process for the held values over the
// run's service channel, and the environment's `secret()`s take them from there: a brokered one
// reaches only the egress gateway, which swaps it in on its hosts, a relayed one too, with its
// hosts' requests sent to its relay, and a sandbox one only the agent's sandbox. The eval code runs in the worker that holds them, so this keeps values out of its reach
// by accident, not against code that reads reeval's own state.
import { placeholder } from '@reeval/sandbox-docker'
import { UsageError } from './errors.ts'
import { isPlaceholder, registerSecret } from './redact.ts'
import { callService } from './scheduler/services.ts'
import { claimSecretsFile, SECRETS_FILE_VAR } from './secrets-file-take.ts'

/** The run service a worker fetches the held values from. */
export const SECRETS_SERVICE = 'secrets'

/**
 * A secret reeval holds out of the environment: its mode, a brokered one's hosts, a relayed one's
 * relay, and its value. A brokered one without hosts, and a relayed one, go where each use sends
 * them: a harness's credential to the harness's endpoints, a key for reeval's own model calls to
 * its provider's or gateway's API. A relayed one's requests to those hosts go to `via` instead,
 * with `via`'s path before their own.
 */
export type HeldSecret =
  | { mode: 'brokered'; hosts?: string[]; value: string }
  | { mode: 'relayed'; via: string; value: string }
  | { mode: 'sandbox'; value: string }

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/

const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

const held = new Map<string, HeldSecret>()
let fetched: Promise<void> | undefined

function parse(
  text: string,
  file: string,
): Record<string, HeldSecret | { mode: 'readable'; value: string }> {
  const bad = (why: string) => new UsageError(`${SECRETS_FILE_VAR} names ${file}, which ${why}`)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw bad("isn't JSON")
  }
  const d = doc as { version?: unknown; secrets?: unknown } | null
  if (typeof d !== 'object' || d === null || Array.isArray(d)) throw bad("isn't a JSON object")
  if (d.version !== 1) {
    throw bad(`is version ${JSON.stringify(d.version)}, and this reeval reads version 1`)
  }
  if (typeof d.secrets !== 'object' || d.secrets === null || Array.isArray(d.secrets)) {
    throw bad('has no secrets object')
  }
  const out: Record<string, HeldSecret | { mode: 'readable'; value: string }> = {}
  for (const [name, raw] of Object.entries(d.secrets)) {
    if (!VAR.test(name))
      throw bad(`has a secret named ${JSON.stringify(name)}, which isn't a variable name`)
    const s = raw as { mode?: unknown; hosts?: unknown; via?: unknown; value?: unknown } | null
    if (typeof s?.value !== 'string' || !s.value) throw bad(`has no value for ${name}`)
    const hosts = s.hosts
    if (s.mode === 'relayed') {
      const via = typeof s.via === 'string' ? URL.parse(s.via) : null
      if (
        !via ||
        (via.protocol !== 'https:' && !(via.protocol === 'http:' && LOOPBACK.test(via.hostname)))
      ) {
        throw bad(`has no https:// via for ${name}, which is relayed`)
      }
      out[name] = { mode: 'relayed', via: s.via as string, value: s.value }
    } else if (s.mode === 'brokered' && hosts === undefined) {
      out[name] = { mode: 'brokered', value: s.value }
    } else if (s.mode === 'brokered') {
      if (
        !Array.isArray(hosts) ||
        !hosts.length ||
        !hosts.every((h): h is string => typeof h === 'string' && h.length > 0)
      ) {
        throw bad(`has no hosts for ${name}, which is brokered: list them, or leave hosts out`)
      }
      const named = hosts.map((h) => h.toLowerCase())
      const off = named.find((h) => !HOST.test(h))
      if (off !== undefined) {
        throw bad(
          `gives ${name} the host ${JSON.stringify(off)}, which isn't a host name: give the name alone, with no scheme, port or path`,
        )
      }
      out[name] = { mode: 'brokered', hosts: [...new Set(named)], value: s.value }
    } else if (s.mode === 'sandbox' || s.mode === 'readable') {
      out[name] = { mode: s.mode, value: s.value }
    } else {
      throw bad(
        `gives ${name} the mode ${JSON.stringify(s.mode)}, not brokered, relayed, sandbox or readable`,
      )
    }
  }
  return out
}

/**
 * Reads and deletes the file `REEVAL_SECRETS_FILE` names, when it's set, and unsets it, so no
 * worker sees it. A name in the file wins over the same name in the environment.
 */
export function readSecretsFile(env: NodeJS.ProcessEnv = process.env): void {
  const taken = claimSecretsFile(env)
  if (!taken) return
  const { file } = taken
  if ('error' in taken) {
    throw new UsageError(
      `${SECRETS_FILE_VAR} names ${file}, which reeval can't read: ${taken.error}`,
    )
  }
  const { text } = taken
  for (const [name, secret] of Object.entries(parse(text, file))) {
    registerSecret(secret.value)
    if (secret.mode === 'readable') {
      env[name] = secret.value
      held.delete(name)
      continue
    }
    held.set(name, secret)
    env[name] = placeholder()
  }
}

/** The held secrets, as the main process answers a worker's call for them. */
export const heldSecrets = (): Record<string, HeldSecret> => Object.fromEntries(held)

/**
 * Makes the main process's held secrets this process's, once: a worker fetches them over the
 * run's service channel; the main process already has them.
 */
export function fetchHeldSecrets(): Promise<void> {
  fetched ??= (
    callService(SECRETS_SERVICE, {}, async () => heldSecrets()) as Promise<
      Record<string, HeldSecret>
    >
  ).then(
    (secrets) => {
      for (const [name, secret] of Object.entries(secrets ?? {})) {
        registerSecret(secret.value)
        held.set(name, secret)
      }
    },
    // A run without the service (one that read no file) holds nothing.
    () => {},
  )
  return fetched
}

/** The held secret named `name`, which a `secret()` reading that host variable gets. */
export const heldSecret = (name: string): HeldSecret | undefined => held.get(name)

/**
 * `env` with each held secret's value where `env` has its placeholder: what reeval's own calls on
 * the host authenticate with (the agent's key, the judge's, a sandbox provider's, a workspace's
 * token), none of which the eval code reads.
 */
export function hostEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!held.size) return env
  const out = { ...env }
  for (const [name, secret] of held) {
    if (isPlaceholder(env[name])) out[name] = secret.value
  }
  return out
}
