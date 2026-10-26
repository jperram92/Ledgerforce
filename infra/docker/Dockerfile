# LedgerForce application images for the self-hosted install (T-0094, RQ-0041, DL-0196).
# One multi-stage build, four targets:
#   api     NestJS API (SWC build), runs as lf_app
#   worker  pg-boss outbox consumer, runs as lf_app
#   setup   one-shot first start: migrations + queue as lf_migrator, first Owner (ADR-0037)
#   web     the SPA served by nginx (unprivileged), with the same-origin proxy to api and Keycloak
# Build from the repository root:  docker build -f infra/docker/Dockerfile --target api .
#
# Workspace packages are TypeScript source run by Node's type stripping, which Node refuses under
# node_modules; so the runtime keeps the pnpm workspace layout (symlinks), not `pnpm deploy`.
# Base images are pinned by digest; bump tag and digest together.

FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS base
ENV CI=true \
    PNPM_HOME=/pnpm \
    COREPACK_HOME=/corepack \
    NODE_ENV=production
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm version from package.json "packageManager"; prepared once, readable by every user.
RUN corepack enable && corepack prepare --activate && chmod -R a+rX /corepack

# Every package's dependencies, fetched by lockfile only (cached until the lockfile changes).
FROM base AS fetch
RUN pnpm fetch --frozen-lockfile

# Full install and build: the API with SWC, the SPA with Vite.
FROM fetch AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline \
 && pnpm --filter @ledgerforce/api build \
 && pnpm --filter @ledgerforce/web build

# Production dependencies only, same workspace layout.
FROM fetch AS prod
COPY . .
RUN pnpm install --frozen-lockfile --offline --prod --ignore-scripts \
 && rm -rf apps/web packages/ui

FROM base AS node-runtime
COPY --from=prod /app /app
COPY --from=build /app/apps/api/dist /app/apps/api/dist
# Files belong to root and are read-only for the runtime user.
USER node
ENV HOME=/tmp

FROM node-runtime AS api
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM node-runtime AS worker
CMD ["node", "apps/worker/src/main.ts"]

FROM node-runtime AS setup
CMD ["node", "apps/worker/src/cli/setup.ts"]

FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS web
COPY infra/docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
ENV NGINX_PORT=8080
EXPOSE 8080
USER 101
