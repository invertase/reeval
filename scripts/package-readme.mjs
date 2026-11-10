// The published package's README: the repo-root README with each relative link made absolute, to
// the file at the release's tag on GitHub. The tarball ships the README without the docs it
// links to, and npm resolves a relative link against the package's directory, not the repo root.

const REPO = 'https://github.com/reeval-ai/reeval'

/** `README.md`'s text as the tarball ships it for `version`. */
export function packageReadme(text, version) {
  return text.replace(/\]\(([^)\s]+)\)/g, (link, target) =>
    /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)
      ? link
      : `](${REPO}/blob/v${version}/${target.replace(/^\.\//, '')})`,
  )
}
