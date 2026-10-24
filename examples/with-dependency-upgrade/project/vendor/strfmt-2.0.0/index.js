// Replaces each `{name}` in the template with `values[name]`; a missing value throws.
export function format(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`format: no value for {${name}}`)
    return String(values[name])
  })
}
