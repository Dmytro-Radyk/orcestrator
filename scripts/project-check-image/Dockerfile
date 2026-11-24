ARG NODE_VERSION=24
ARG POSTGRES_VERSION=17
FROM node:${NODE_VERSION}-bookworm-slim AS node-runtime
FROM postgres:${POSTGRES_VERSION}-bookworm
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -u 1000 -m node \
    && printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"\n' > /usr/local/bin/project-chromium \
    && chmod 755 /usr/local/bin/project-chromium
COPY run-check.mjs /opt/orcestrator/run-check.mjs
