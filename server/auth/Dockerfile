# Build context is the workspace root (server/), NOT server/auth — pnpm needs
# the lockfile + every package manifest to resolve the workspace links.
#
#   docker build -f server/auth/Dockerfile server/
#
# Stage 1: install this service's production closure with pnpm.
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /workspace

# Manifest-first: copy only the files that affect dependency resolution so the
# install layer stays cached across source-only changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/package.json ./shared/
COPY auth/package.json ./auth/

# Install only @meetai/auth and its workspace deps (incl. @meetai/shared).
RUN pnpm install --filter @meetai/auth... --frozen-lockfile --prod

# Bring in the source. shared/ is a workspace dependency so it ships too.
COPY shared ./shared
COPY auth ./auth

# Stage 2: runtime. Copy the whole installed workspace tree in one shot so
# pnpm's relative symlinks (node_modules/.pnpm + the @meetai/shared link)
# all resolve intact.
FROM node:22-alpine AS runtime
WORKDIR /workspace
COPY --from=deps /workspace ./

WORKDIR /workspace/auth
EXPOSE 4020
USER node
CMD ["node", "src/server.js"]
