/** An error subclass and a class instance, each of which a failed matcher quotes by its class. */
export class TokenError extends Error {
  override name = 'TokenError'
}

export class Holder {
  held: string
  constructor(held: string) {
    this.held = held
  }
}
