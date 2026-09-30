import { evaluate, expect } from 'reeval'
import { COMMAND_OUTPUT, notes, prompts, toolsMentioning, trimmed } from './probes.ts'

// The agent edits a file and runs a command, and the transcript has both: an edit of notes.txt
// (a file-edit event, or a tool call that names the file when the agent edits it from the shell)
// and a tool call whose output is what only running the command prints.
evaluate('edit and run', { environment: notes }, async (c) => {
  const turn = await c.send(prompts.editAndRun)
  expect(await trimmed(c.readFile, 'notes.txt')).toBe('status: final')
  const edits = turn.transcript.filter((e) => e.type === 'file-edit' && e.path === 'notes.txt')
  expect(edits.length + toolsMentioning(turn, 'notes.txt').length).toBeGreaterThan(0)
  expect(toolsMentioning(turn, COMMAND_OUTPUT)).not.toEqual([])
})

// Must fail: with no turn, the file is as the environment wrote it.
evaluate('edit and run canary', { environment: notes }, async (c) => {
  await c.sandbox()
  expect(await trimmed(c.readFile, 'notes.txt')).toBe('status: final')
})
