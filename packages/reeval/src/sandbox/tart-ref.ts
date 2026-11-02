// How Tart reads an image name, for planning: no I/O, so the plan's checks can use it.

/** An OCI image, by registry host, repository, and a tag or digest; or a local VM, by name. */
export type TartRef =
  | { oci: true; host: string; repo: string; tag: string | null; digest: string | null }
  | { oci: false; name: string }

/** How Tart reads `image`: a name with a `/` is an OCI image, anything else a local VM. */
export function parseTartRef(image: string): TartRef {
  const slash = image.indexOf('/')
  if (slash < 0) return { oci: false, name: image }
  const host = image.slice(0, slash)
  const path = image.slice(slash + 1)
  const at = path.indexOf('@')
  if (at >= 0)
    return { oci: true, host, repo: path.slice(0, at), tag: null, digest: path.slice(at + 1) }
  const colon = path.lastIndexOf(':')
  return colon > path.lastIndexOf('/')
    ? { oci: true, host, repo: path.slice(0, colon), tag: path.slice(colon + 1), digest: null }
    : { oci: true, host, repo: path, tag: null, digest: null }
}

/** The plan's warning for an OCI image that names `:latest` or no tag, which can move under it. */
export function tartTagWarning(image: string): string | null {
  const ref = parseTartRef(image)
  if (!ref.oci || ref.digest || (ref.tag !== null && ref.tag !== 'latest')) return null
  const which = ref.tag ? 'the moving tag "latest"' : 'no tag (so "latest")'
  return `tart(${image}) uses ${which}: the image can change between runs, so results aren't comparable over time. Pin a version tag or a digest (the digest each attempt cloned is recorded either way).`
}
