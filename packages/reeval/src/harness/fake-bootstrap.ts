import { createHash } from 'node:crypto'
import { shellQuote as q } from '@reeval/sandbox-docker/process'

/** The id of a fake agent's `bootstrap`: what its marker and a baked image are named by. */
export const fakeBootstrapId = (command: string) =>
  createHash('sha256').update(command).digest('hex').slice(0, 8)

/**
 * Runs a fake agent's `bootstrap` in the agent's home unless its marker says it ran there
 * already, as a real adapter's bootstrap does, and leaves the marker once it succeeds.
 */
export const fakeBootstrapScript = (command: string) =>
  `m="$HOME/.reeval-fake-bootstrap-${fakeBootstrapId(command)}.ok"
[ -f "$m" ] && exit 0
cd "$HOME" && bash -c ${q(command)} && touch "$m"`
