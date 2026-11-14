/** A failure of the harness or of where it runs, rather than of the agent's work. */
export class AgentError extends Error {
  override name = 'AgentError'
  /** Another try may succeed: a 5xx, a network error or a timeout, not a refused key or a bad config. */
  readonly transient: boolean
  constructor(message: string, options: { transient?: boolean } = {}) {
    super(message)
    this.transient = options.transient ?? false
  }
}
