# syntax=docker/dockerfile:1
# Build context: repository root (npm workspaces need the root lockfile).

FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/load-test/package.json tools/load-test/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build -w @canvas/shared && npm run build -w @canvas/server \
 && npm prune --omit=dev --ignore-scripts

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/apps/server/package.json ./apps/server/package.json
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/server/migrations ./apps/server/migrations
WORKDIR /app/apps/server
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["node", "dist/main.js"]
