/** The `<provider>` a pi or Goose model id, `<provider>/<model>`, names. */
export const providerOf = (model: string) => model.slice(0, Math.max(model.indexOf('/'), 0))

/** The model id pi or Goose asks its provider for: the id without its `<provider>/`. */
export const withoutProvider = (model: string) => model.slice(model.indexOf('/') + 1)
