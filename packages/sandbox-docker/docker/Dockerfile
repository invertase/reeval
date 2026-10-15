# Base image for reeval sandboxes. `reeval image build` builds this, bakes the Cursor harness
# bootstrap into it and commits the result as the image evals run in.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git procps \
  && rm -rf /var/lib/apt/lists/*

# npm before 11.6 (node:22 ships 10.9) can crash resolving circular peer sets ("reading
# 'edgesOut'", npm/cli#8261), so evals' installs get a fixed npm. The harness bridge installs its
# dependencies with pnpm.
RUN npm install --global npm@11.20.0 && npm install --global pnpm@10.33.3

# The agent, setup steps and checks run as `reeval` (SANDBOX_USER in src/image.ts); image builds stay
# root.
RUN useradd --create-home --shell /bin/bash --uid 10001 --user-group reeval \
  && mkdir -p /reeval/workspace && chown -R reeval:reeval /reeval
ENV PATH=/home/reeval/.local/bin:$PATH
COPY reeval-path.sh /etc/profile.d/00-reeval-path.sh
WORKDIR /reeval/workspace
