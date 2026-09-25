# Base image for ES sandboxes. `es image build` builds this, bakes a harness bootstrap (the
# agent's CLI) into it and commits the result as the image evals run in.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git procps \
  && rm -rf /var/lib/apt/lists/*

# The harness bridge installs its dependencies with pnpm.
RUN npm install --global pnpm@10.33.3

RUN mkdir -p /es/workspace
WORKDIR /es/workspace
