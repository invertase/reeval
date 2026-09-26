// pnpm pack (and so the published tarball) keeps only what an installer needs: devDependencies
// name workspace-only packages that aren't on npm, and scripts only work in this repo.
module.exports = {
  hooks: {
    beforePacking(pkg) {
      delete pkg.devDependencies
      delete pkg.scripts
      return pkg
    },
  },
}
