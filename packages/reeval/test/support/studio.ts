import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStudioApi } from '../../src/studio/server.ts'
import type { StudioSource } from '../../src/studio/source.ts'
import { type PairResponse, type RunList, type RunView, studioPaths } from '../../src/view/api.ts'

/**
 * Everything `reeval studio`'s data server answers for a project's runs (the run list, each run's
 * view, and each attempt with its transcript), fetched as a paired page would and written under
 * `out`, one file per response, so a test can search what the studio shows.
 */
export async function writeStudioResponses(source: StudioSource, out: string): Promise<void> {
  const api = createStudioApi({
    source,
    reeval: 'test',
    project: 'test',
    origin: 'https://studio.example',
    pairingToken: 'test-pairing-token',
    hosts: [],
    focus: null,
  })
  const pair = await api.request(`http://x${studioPaths.pair()}`, {
    method: 'POST',
    body: JSON.stringify({ token: 'test-pairing-token' }),
  })
  const { session } = (await pair.json()) as PairResponse
  let n = 0
  const get = async (path: string, optional = false) => {
    const res = await api.request(`http://x${path}`, {
      headers: { authorization: `Bearer ${session}` },
    })
    if (optional && res.status === 404) return null
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`)
    const text = await res.text()
    writeFileSync(join(out, `${String(++n).padStart(4, '0')}.json`), text)
    return JSON.parse(text) as unknown
  }
  mkdirSync(out, { recursive: true })
  const runs = (await get(`${studioPaths.runs()}?limit=100`)) as RunList
  for (const { runId } of runs.items) {
    const view = (await get(studioPaths.run(runId))) as RunView
    for (const a of view.evals.flatMap((e) => e.attempts)) {
      await get(studioPaths.attempt(runId, a.key))
      await get(`${studioPaths.transcript(runId, a.key)}?limit=2000`, true)
    }
  }
}
