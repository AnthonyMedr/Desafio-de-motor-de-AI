FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
# better-sqlite3 usa binário pronto quando disponível; as ferramentas cobrem o fallback.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

# Ferramentas de desenvolvimento ficam disponíveis para testes e avaliações.
FROM dependencies AS development
COPY scripts ./scripts
COPY tests ./tests
COPY vitest.config.ts ./
COPY migrations ./migrations
COPY tenants ./tenants
RUN mkdir -p /app/reports
CMD ["npm", "test"]

FROM dependencies AS builder
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/atendimento.sqlite
ENV TENANTS_DIR=/app/tenants
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node tenants ./tenants
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
