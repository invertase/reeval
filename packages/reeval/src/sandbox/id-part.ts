/** The last path segment of `text`, with what an id can't hold replaced. */
export const idPart = (text: string) =>
  (text.split('/').at(-1) ?? text).replace(/[^A-Za-z0-9._:@-]+/g, '-')
