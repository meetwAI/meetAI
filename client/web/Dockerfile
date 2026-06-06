# Production image for the web client: build with Vite, serve static with nginx.
#
# Stage 1: build the static bundle.
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

# Manifest-first so the install layer caches across source-only changes.
# This project uses pnpm (pnpm-lock.yaml); --frozen-lockfile keeps it reproducible.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# Stage 2: serve the built assets with nginx.
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html

# NOTE: kept on the stock nginx:alpine entrypoint (root master process, worker
# drops to the nginx user) because the default config binds :80 and writes
# /var/run/nginx.pid, both of which need root. Full non-root hardening means
# switching to nginxinc/nginx-unprivileged + a custom conf (high port, writable
# pid path) — deferred to the Dockerfile-hardening follow-up.

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
