# syntax=docker/dockerfile:1
# Build context: repository root.

FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/load-test/package.json tools/load-test/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG VITE_COLLAB_SERVERS=http://localhost:4000
ENV VITE_COLLAB_SERVERS=${VITE_COLLAB_SERVERS}
RUN npm run build -w @canvas/shared && npm run build -w @canvas/web

FROM nginx:1.27-alpine
# Official nginx image renders /etc/nginx/templates/*.template with env vars at startup.
ENV CSP_CONNECT_SRC="'self' http://localhost:4000 ws://localhost:4000"
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
