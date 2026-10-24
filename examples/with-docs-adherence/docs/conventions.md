# Handler conventions

- A handler takes plain arguments and returns `{ status, body }`. It never throws.
- An error's body is `{ error: { code, message } }`: `code` is a snake_case identifier,
  `message` a sentence for a person.
- A missing note is `404` with code `not_found`.
- A delete that worked is `204` with a `null` body.
- Every handler has a test in `test/notes.test.js` for its success and each of its errors.
