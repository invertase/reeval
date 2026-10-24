/** Fails its first run in a workspace, as a transient would, and passes from then on. */
export const FLAKY = 'test -f .tried || { touch .tried; echo transient >&2; exit 1; }'
