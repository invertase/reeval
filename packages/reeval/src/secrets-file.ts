// `REEVAL_SECRETS_FILE`: secrets handed to reeval with the mode that decides who sees each value.
// reeval reads the file once as it starts, before it loads a config, and deletes it. A `readable`
// value goes into the environment as a variable would; a `brokered` or `sandbox` one is held here,
// out of every environment, and the environment gets a placeholder in its place, so the eval code
// reads a placeholder. An attempt's worker asks the main process for the held values over the
// run's service channel, and the environment's `secret()`s take them from there: a brokered one
// reaches only the egress gateway, which swaps it in on its hosts, a sandbox one only the agent's
// sandbox. The eval code runs in the worker that holds them, so this keeps values out of its reach
// by accident, not against code that reads reeval's own state.
import { readFileSync, rmSync } from 'node:fs'
import { placeholder } from '@reeval/sandbox-docker'
import { UsageError } from './errors.ts'
import { registerSecret } from './redact.ts'
import { callService } from './scheduler/services.ts'

export const SECRETS_FILE_VAR = 'REEVAL_SECRETS_FILE'
/** The run service a worker fetches the held values from. */
export const SECRETS_SERVICE = 'secrets'

/** A secret reeval holds out of the environment: its mode, a brokered one's hosts and its value. */
export type HeldSecret =
  | { mode: 'brokered'; hosts: string[]; value: string }
  | { mode: 'sandbox'; value: string }

const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/

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
    const s = raw as { mode?: unknown; hosts?: unknown; value?: unknown } | null
    if (typeof s?.value !== 'string' || !s.value) throw bad(`has no value for ${name}`)
    const hosts = s.hosts
    if (s.mode === 'brokered') {
      if (
        !Array.isArray(hosts) ||
        !hosts.length ||
        !hosts.every((h): h is string => typeof h === 'string' && h.length > 0)
      ) {
        throw bad(`has no hosts for ${name}, which is brokered`)
      }
      out[name] = { mode: 'brokered', hosts: [...hosts], value: s.value }
    } else if (s.mode === 'sandbox' || s.mode === 'readable') {
      out[name] = { mode: s.mode, value: s.value }
    } else {
      throw bad(
        `gives ${name} the mode ${JSON.stringify(s.mode)}, not brokered, sandbox or readable`,
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
  const file = env[SECRETS_FILE_VAR]
  if (file === undefined) return
  delete env[SECRETS_FILE_VAR]
  if (!file) return
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new UsageError(
      `${SECRETS_FILE_VAR} names ${file}, which reeval can't read: ${(error as Error).message}`,
    )
  } finally {
    rmSync(file, { force: true })
  }
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
