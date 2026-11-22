# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:26.13.1-alpine
ARG APP_VERSION=2.0.0-hardened

# Stage 1: Build Vite + shadcn/ui SPA
FROM ${NODE_IMAGE} AS fe-builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY vite.config.js components.json ./
COPY client ./client
COPY public ./public
RUN npm run build

# Stage 2: Production runtime dependencies ONLY (4 packages: bcryptjs, jose, undici, uuid)
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# Stage 3: Ultra-slim hardened runtime image (Zero Next.js, Zero devDependencies)
FROM ${NODE_IMAGE} AS runner
ARG APP_VERSION
WORKDIR /app

LABEL org.opencontainers.image.title="slim-router" \
      org.opencontainers.image.source="https://github.com/fizray/slim-router" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/app/data
ENV HOME=/tmp

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=fe-builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node server ./server
COPY --chown=node:node src ./src
COPY --chown=node:node open-sse ./open-sse
COPY --chown=node:node public ./public

RUN mkdir -p /app/data/db /app/data/backups && \
    chown -R node:node /app/data

EXPOSE 20128

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:20128/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "./server/loader.js", "server/index.js"]
