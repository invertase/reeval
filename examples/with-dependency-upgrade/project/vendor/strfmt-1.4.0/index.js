// Replaces each `%s` in the template with the next argument.
export function format(template, ...args) {
  let next = 0
  return template.replace(/%s/g, () => String(args[next++]))
}
