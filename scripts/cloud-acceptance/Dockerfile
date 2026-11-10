FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci --omit=dev --workspace server --include-workspace-root=false
COPY scripts/cloud-acceptance/core.mjs scripts/cloud-acceptance/receiver.mjs ./scripts/cloud-acceptance/
USER node
ENV PORT=8080 NODE_ENV=production
CMD ["node", "scripts/cloud-acceptance/receiver.mjs"]
