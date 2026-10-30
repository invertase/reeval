ARG REEVAL_BASE
FROM ${REEVAL_BASE}
# Node 22 beside the image's own Node, for the canary: its undici 6 warns under NODE_USE_ENV_PROXY.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /opt/node-22/node
