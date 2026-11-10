FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci --workspace server --include-workspace-root=false
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src
RUN npm run build --workspace server
RUN npm prune --omit=dev --workspace server --include-workspace-root=false && mkdir -p server/node_modules

FROM node:24-bookworm-slim
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/bluegrain-llc/sms-reader"
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
