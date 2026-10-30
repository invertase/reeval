# Base image for reeval sandboxes. `reeval image build` builds this, bakes the Cursor harness
# bootstrap into it and commits the result as the image evals run in.
FROM node:26-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git procps \
  && rm -rf /var/lib/apt/lists/*

# npm and pnpm are pinned so evals' installs don't move with the Node image's bundled npm. The
# harness bridge installs its dependencies with pnpm. Versions come from `reeval image build`
# (`NPM_VERSION` / `PNPM_VERSION`).
ARG NPM_VERSION
ARG PNPM_VERSION
RUN test -n "$NPM_VERSION" && test -n "$PNPM_VERSION" \
  && npm install --global "npm@${NPM_VERSION}" && npm install --global "pnpm@${PNPM_VERSION}"

# The agent, setup steps and checks run as `reeval` (SANDBOX_USER in src/image.ts); image builds stay
# root.
RUN useradd --create-home --shell /bin/bash --uid 10001 --user-group reeval \
  && mkdir -p /reeval/workspace && chown -R reeval:reeval /reeval
ENV PATH=/home/reeval/.local/bin:$PATH
COPY reeval-path.sh /etc/profile.d/00-reeval-path.sh
WORKDIR /reeval/workspace
