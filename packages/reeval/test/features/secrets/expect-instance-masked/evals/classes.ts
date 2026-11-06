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

/** AxiosError's shape: an error subclass whose `toJSON` reads a private field. */
export class AxiosLike extends Error {
  override name = 'AxiosLike'
  #code: string
  constructor(message: string, code = 'ERR_BAD_REQUEST') {
    super(message)
    this.#code = code
  }
  toJSON() {
    return { message: this.message, code: this.#code }
  }
}
