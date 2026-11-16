# The API runs as one Node process against Postgres. The web app is deployed
# separately as static assets; this image does not build or serve it.
FROM node:22-bookworm-slim

RUN npm install -g pnpm@10.34.9

WORKDIR /app

# Manifests first, so a source change reuses the installed dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/sync/package.json packages/sync/package.json
COPY tools tools

RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages packages

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["pnpm", "--filter", "@farmatics/api", "start"]
