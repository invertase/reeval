FROM debian:bookworm-slim
RUN mkdir -p /opt/reeval-fixture/bin \
  && printf '#!/bin/sh\necho reeval-fixture-tool\n' > /opt/reeval-fixture/bin/reeval-fixture-tool \
  && chmod +x /opt/reeval-fixture/bin/reeval-fixture-tool
ENV PATH=/opt/reeval-fixture/bin:$PATH
