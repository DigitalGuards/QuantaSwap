FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runtime

ENV NODE_ENV=production \
    ORDERBOOK_HOST=0.0.0.0 \
    PORT=8091 \
    ORDERBOOK_DATA=/var/lib/quantaswap-orderbook/orders.json \
    ORDERBOOK_TRUST_PROXY=none

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /var/lib/quantaswap-orderbook && chown node:node /var/lib/quantaswap-orderbook

USER node
EXPOSE 8091
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/server.js"]
