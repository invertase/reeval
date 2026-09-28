# Layered on reeval's sandbox image, so the harness bootstrap is already in it. reeval builds this with
# `docker build` from this directory and tags it by content hash.
ARG REEVAL_BASE
FROM ${REEVAL_BASE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*

COPY seed.sql /opt/seed.sql
