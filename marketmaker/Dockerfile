FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build

WORKDIR /app/marketmaker
COPY marketmaker/package.json marketmaker/package-lock.json ./
RUN npm ci
COPY marketmaker/tsconfig.json ./
COPY marketmaker/src ./src
COPY config/protocol-v2.json /app/config/protocol-v2.json
COPY config/protocol-v2-vectors.json /app/config/protocol-v2-vectors.json
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime

ENV NODE_ENV=production \
    MM_STATE_FILE=/var/lib/quantaswap-marketmaker/state.json \
    MM_HEALTH_HOST=0.0.0.0 \
    MM_HEALTH_PORT=8092

WORKDIR /app/marketmaker
COPY --from=build --chown=node:node /app/marketmaker/package.json /app/marketmaker/package-lock.json ./
COPY --from=build --chown=node:node /app/marketmaker/node_modules ./node_modules
COPY --from=build --chown=node:node /app/marketmaker/dist ./dist
COPY --from=build --chown=node:node /app/config /app/config
RUN mkdir -p /var/lib/quantaswap-marketmaker && chown node:node /var/lib/quantaswap-marketmaker

USER node
EXPOSE 8092
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
