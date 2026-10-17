/** Any non-null object, arrays included, as a bag of properties to read without trusting. */
export const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** `value` is one of `list`'s members. */
export const isOneOf = <T>(list: readonly T[], value: unknown): value is T =>
  list.some((member) => member === value)
