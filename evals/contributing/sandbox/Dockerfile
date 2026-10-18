ARG REEVAL_BASE
FROM ${REEVAL_BASE}

# Each task's pnpm-lock.yaml and patches (scripts/lockfiles.mjs copies them here), fetched into
# one store at build time, so an attempt's `pnpm install` copies from the store, not the network.
COPY lockfiles/ /tmp/lockfiles/
RUN set -e; \
  for dir in /tmp/lockfiles/*/; do (cd "$dir" && pnpm fetch --store-dir /opt/pnpm-store); done; \
  rm -rf /tmp/lockfiles; \
  chown -R reeval /opt/pnpm-store; \
  printf 'store-dir=/opt/pnpm-store\n' > /home/reeval/.npmrc; \
  chown reeval /home/reeval/.npmrc
