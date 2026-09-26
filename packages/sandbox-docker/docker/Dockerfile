# Base image for ES sandboxes. `es image build` builds this, bakes the Cursor harness
# bootstrap into it and commits the result as the image evals run in.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git procps \
  && rm -rf /var/lib/apt/lists/*

# npm 10.9 (node:22's) crashes installing a local tarball ("reading 'edgesOut'"); keep in step
# with NPM_VERSION in src/build-image.ts. The harness bridge installs its dependencies with pnpm.
RUN npm install --global npm@11.20.0 && npm install --global pnpm@10.33.3

RUN mkdir -p /es/workspace
WORKDIR /es/workspace
