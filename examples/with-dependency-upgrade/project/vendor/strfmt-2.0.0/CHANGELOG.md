# strfmt

## 2.0.0

- **Breaking:** `format(template, values)` takes named placeholders, `{name}`, and one object of
  values. `%s` is no longer replaced, and a placeholder with no value throws.

## 1.4.0

- `format()` takes any number of arguments.
