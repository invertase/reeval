# reeval builds this from its directory and passes REEVAL_BASE, its own image for the harness, so
# the result already has the agent in it.
ARG REEVAL_BASE
FROM ${REEVAL_BASE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*

COPY seed.sql /opt/seed.sql
RUN sqlite3 /opt/shop.db < /opt/seed.sql
