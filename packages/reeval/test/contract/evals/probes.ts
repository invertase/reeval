import { defineEnvironment, type HarnessOption, type PluginPart, type Turn } from 'reeval'
import { BLOCKED_HOST, COMMAND, PLANTED, PLUGIN_AGENT, RULES_WORD, reach } from './constants.ts'

// What every harness in the contract gets, and the signals the checks read. The prompts are one
// short turn each and name the exact action; the checks read what the model can't fake: a file a
// tool wrote, a tool's own output, the record. See test/contract/README.md.

export * from './constants.ts'

export const skilled = defineEnvironment('skilled', ({ skill }) => ({
  skills: [skill.local('../skills/contract-probe')],
}))
export const ruled = defineEnvironment('ruled', {
  rules: `# House rules\n\nThe house codeword is ${RULES_WORD}. When anyone asks for the house codeword, write it (the codeword only) into a file named codeword.txt in the workspace root.\n`,
})
export const stamped = defineEnvironment('stamped', ({ file, mcp }) => ({
  files: { '~/reeval-mcp/stamp.mjs': file('../stamp.mjs') },
  mcp: { stamp: mcp.stdio('node', ['/home/reeval/reeval-mcp/stamp.mjs']) },
}))
export const notes = defineEnvironment('notes', { files: { 'notes.txt': 'status: draft\n' } })
export const scanned = defineEnvironment('scanned', ({ file }) => ({
  files: { '~/.reeval-contract/scan.mjs': file('../scan.mjs') },
}))
export const planted = scanned.extendEnvironment('planted', {
  env: { CONTRACT_PLANTED: PLANTED },
  files: { '~/.contract-planted': `${PLANTED}\n` },
})
export const closed = defineEnvironment('closed', { egress: 'deny-all' })
/**
 * The probe plugin alone, under deny-all: whatever else the agent loads or contacts is a leak. Its
 * `only` is the parts the row's harness loads (`REEVAL_CONTRACT_PLUGIN_PARTS`); unset, it keeps
 * every part.
 */
export const plugged = defineEnvironment('plugged', ({ plugin }) => {
  const parts = process.env.REEVAL_CONTRACT_PLUGIN_PARTS
  return {
    egress: 'deny-all',
    plugins: [
      plugin.local('../plugins/probe', parts ? { only: parts.split(',') as PluginPart[] } : {}),
    ],
  }
})

export const prompts = {
  skill:
    'Use your contract-probe skill: do exactly what it says, then stop. Keep your reply short.',
  rules: 'What is the house codeword? Follow your house rules for it, then stop.',
  mcp: 'Call the house_stamp tool of the stamp MCP server once, then reply with what it returned.',
  editAndRun: `In notes.txt, change the word draft to final with your file editing tool. Then run this exact shell command once: ${COMMAND}. Then stop.`,
  key: 'Reply with the single word OK. Do not run any tools.',
  egress: `Run this exact shell command once, then stop: ${reach(BLOCKED_HOST)}`,
  pluginSkill:
    'Use your plugin-probe skill, from the probe plugin: do exactly what it says, then stop. Keep your reply short.',
  pluginMcp:
    "Call the house_stamp tool of the probe plugin's stamp MCP server once, then reply with what it returned.",
  pluginHook: 'Reply with the single word OK. Do not run any tools.',
  pluginAgent: `Run the ${PLUGIN_AGENT} subagent, from the probe plugin, once with your subagent tool, giving it the task "Say PONG." Then reply with what it said. Do not answer for it.`,
}

/**
 * The fake agent's script for the key-free row: every probe's action, on every turn. It reads the
 * skill and the rules where reeval put them, so it's a check of the suite, not of a model.
 */
export const fakeScript = [
  { exec: `grep -o 'PROBE-[A-Z0-9-]*' ~/.agents/skills/contract-probe/SKILL.md > skill-proof.txt` },
  { exec: `grep -o 'TANGERINE-[0-9]*' AGENTS.md > codeword.txt || true` },
  { write: { 'notes.txt': 'status: final\n' } },
  { exec: COMMAND },
  { exec: `${reach(BLOCKED_HOST)} || true` },
  { exec: `curl -sS -m 20 -o /dev/null https://api2.cursor.sh/ || true` },
  { reply: 'OK' },
]

/**
 * For the MCP eval: the fake agent also calls the stamp server's tool (other environments have no
 * server, so it can't be in every turn's script). Real harnesses are left as they are.
 */
export const withFakeMcp: HarnessOption = (inherited) =>
  inherited.map((h) =>
    h.kind === 'fake' && h.script
      ? { ...h, script: h.script.map((steps) => [{ mcp: 'stamp/house_stamp' }, ...steps]) }
      : h,
  )

/**
 * For the plugin evals: the fake agent without a layout, which takes every plugin part and
 * places plugin skills with its own, does each plugin probe's action from the files reeval
 * placed: it reads the skill, calls the plugin's MCP server, runs the hook's command from the
 * placed hooks.json and reads the subagent. Real harnesses are left as they are.
 */
export const withFakePlugin: HarnessOption = (inherited) =>
  inherited.map((h) =>
    h.kind === 'fake' && h.script
      ? {
          kind: 'fake',
          script: [
            [
              {
                exec: `grep -o 'PLUGIN-[A-Z0-9-]*' ~/.agents/skills/plugin-probe/SKILL.md > plugin-proof.txt`,
              },
              { mcp: 'probe:stamp/house_stamp' },
              {
                exec: `sh -c "$(node -p 'require(process.env.HOME + "/.reeval/plugins/probe/hooks/hooks.json").hooks.SessionStart[0].hooks[0].command')"`,
              },
              { exec: `cat ~/.reeval/plugins/probe/agents/${PLUGIN_AGENT}.md` },
              { reply: 'OK' },
            ],
          ],
        }
      : h,
  )

/** The trimmed file, or null when it's missing. */
export const trimmed = async (read: (path: string) => Promise<string | null>, path: string) =>
  (await read(path))?.trim() ?? null

const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? ''))

/** Tool events whose input or output mentions `needle`, as `tool: input → output` lines. */
export const toolsMentioning = (turn: Turn | undefined, needle: string) =>
  (turn?.transcript ?? []).flatMap((e) =>
    e.type === 'tool' && (text(e.input).includes(needle) || text(e.output).includes(needle))
      ? [`${e.tool}: ${text(e.input).slice(0, 200)} → ${text(e.output).slice(0, 200)}`]
      : [],
  )

/** Every tool event's name. */
export const toolNames = (turn: Turn | undefined) =>
  (turn?.transcript ?? []).flatMap((e) => (e.type === 'tool' ? [e.tool] : []))

/** What `scan.mjs` found: each place a target's bytes appear. */
export type ScanResult = { files: number; bytes: number; hits: string[] }

/**
 * Runs the scanner in the sandbox for `targets` (sha256, length and rolling hash of each form of
 * a value, never the value itself) and returns what it found.
 */
export async function scan(
  exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  targets: string,
): Promise<ScanResult> {
  const r = await exec(`node ~/.reeval-contract/scan.mjs '${targets}'`)
  if (r.exitCode !== 0) throw new Error(`the scanner failed: ${r.stderr}`)
  return JSON.parse(r.stdout) as ScanResult
}
