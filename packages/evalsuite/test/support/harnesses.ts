// Every harness the real-agent suites (contract.test.ts, e2e-real.test.ts) run, one row each.
// Adding a harness to them means adding a row here, and a case to the contract's es.config.ts.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { type BakedHarness, imageFor } from '@evalsuite/sandbox-docker'

export type HarnessRow = {
  /** `ES_CONTRACT_HARNESS`, and the name in test titles. */
  id: 'fake' | 'cursor' | 'antigravity' | 'claude-code'
  /** The cheapest model that does the job; null for the fake agent. */
  model: string | null
  /**
   * The host variable the harness authenticates with, and the variables it's read from, in order
   * (the first that's set). Null for the fake agent, which needs no key.
   */
  key: { name: string; from: string[] } | null
  /** ES's image for it, which the Docker tier needs built. */
  image: BakedHarness
  /** Where the placed contract skill shows up in the attempt's `context`. */
  skillContext: RegExp
  /** What a restricted policy allows automatically for it. */
  autoHosts: string[]
  /** A host it reaches on every turn; null for the fake agent, which reaches none. */
  apiHost: string | null
  /** Whether it reports token usage for each turn; checked either way. */
  tokens: boolean
  /** The model id the record says served the turns; null when the harness can't say. */
  servedModel: RegExp | null
}

export const harnesses: HarnessRow[] = [
  {
    id: 'fake',
    model: null,
    key: null,
    image: 'cursor',
    skillContext: /^~\/\.agents\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api2.cursor.sh', '*.cursor.sh', 'cursor.com', '*.cursor.com'],
    apiHost: null,
    tokens: false,
    servedModel: null,
  },
  {
    id: 'cursor',
    model: 'composer-2.5',
    key: { name: 'CURSOR_API_KEY', from: ['CURSOR_API_KEY'] },
    image: 'cursor',
    skillContext: /^~\/(.+\/)?\.agents\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api2.cursor.sh', '*.cursor.sh', 'cursor.com', '*.cursor.com'],
    apiHost: 'api2.cursor.sh',
    tokens: false,
    servedModel: null,
  },
  {
    id: 'antigravity',
    model: 'gemini-3.8-flash-low',
    key: { name: 'GEMINI_API_KEY', from: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] },
    image: 'antigravity',
    skillContext: /^~\/\.gemini\/config\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['generativelanguage.googleapis.com'],
    apiHost: 'generativelanguage.googleapis.com',
    tokens: true,
    servedModel: /^gemini-3\.8-flash/,
  },
  {
    id: 'claude-code',
    model: 'claude-haiku-4-5',
    key: { name: 'ANTHROPIC_API_KEY', from: ['ANTHROPIC_API_KEY'] },
    image: 'claude-code',
    skillContext: /^~\/\.claude\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api.anthropic.com', '*.anthropic.com'],
    apiHost: 'api.anthropic.com',
    tokens: true,
    servedModel: /^claude-haiku-4-5/,
  },
]

/** The row's key from the host, or undefined when none of its variables is set. */
export const keyOf = (row: HarnessRow) =>
  row.key?.from.map((name) => process.env[name]).find(Boolean)

/** The cell's harness id in attempt ids: `cursor:composer-2.5`, or `fake`. */
export const cellOf = (row: HarnessRow) => (row.model ? `${row.id}:${row.model}` : row.id)

const imageBuilt = (ref: string) => {
  try {
    execFileSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Why a row doesn't run here, or false. Real rows run only with `ES_TEST_REAL=1` (they spend
 * money) and their key, and skip without it, saying so; `ES_CONTRACT_HARNESSES=cursor,…` picks
 * rows. A missing image fails instead under `ES_TEST_REQUIRE_DOCKER=1`, as the Docker tier does.
 */
export function skipRow(row: HarnessRow): string | false {
  const only = process.env.ES_CONTRACT_HARNESSES?.split(',')
  if (only && !only.includes(row.id)) return `ES_CONTRACT_HARNESSES=${only.join(',')}`
  if (row.key) {
    if (process.env.ES_TEST_REAL !== '1') return 'set ES_TEST_REAL=1 to run real agents'
    if (!keyOf(row)) return `${row.key.from.join(' or ')} isn't set, so ${row.id} can't run`
  }
  if (process.env.ES_TEST_REQUIRE_DOCKER === '1') return false
  if (!imageBuilt(imageFor(row.image)))
    return `needs Docker and ${imageFor(row.image)} (es image build)`
  return false
}

/** The host environment for `es run` on this row: the key under its own name, and the row's pick. */
export function rowEnv(row: HarnessRow): NodeJS.ProcessEnv {
  const key = keyOf(row)
  return {
    ...(row.id === 'fake' ? {} : { ES_CONTRACT_HARNESS: row.id }),
    ...(row.model ? { ES_CONTRACT_MODEL: row.model } : {}),
    ...(row.key && key ? { [row.key.name]: key } : {}),
    ...(process.env.ES_RAW_TRANSCRIPT ? { ES_RAW_TRANSCRIPT: process.env.ES_RAW_TRANSCRIPT } : {}),
  }
}

/** The rolling hash `scan.mjs` uses: base 257, mod 2^32, over the bytes. */
export function rollingHash(bytes: Uint8Array): number {
  let h = 0
  for (const b of bytes) h = (Math.imul(h, 257) + b) >>> 0
  return h
}

/**
 * The scanner's targets for a value: its raw and base64 forms, each as a sha256, a length and a
 * rolling hash. The value itself never goes into the sandbox.
 */
export function scanTargets(value: string): string {
  const forms: Array<[string, Buffer]> = [
    ['raw', Buffer.from(value)],
    ['base64', Buffer.from(Buffer.from(value).toString('base64'))],
  ]
  return JSON.stringify(
    forms.map(([form, bytes]) => ({
      form,
      len: bytes.length,
      roll: rollingHash(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  )
}
