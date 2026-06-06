# Build context is the workspace root (server/), NOT server/meetings — pnpm
# needs the lockfile + every package manifest to resolve the workspace links.
#
#   docker build -f server/meetings/Dockerfile server/
#
# Stage 1: install this service's production closure with pnpm.
FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /workspace

# Manifest-first: copy only the files that affect dependency resolution so the
# install layer stays cached across source-only changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/package.json ./shared/
COPY meetings/package.json ./meetings/

# Install only @meetai/meetings and its workspace deps (incl. @meetai/shared).
RUN pnpm install --filter @meetai/meetings... --frozen-lockfile --prod

# Bring in the source. shared/ is a workspace dependency so it ships too.
COPY shared ./shared
COPY meetings ./meetings

# Stage 2: runtime. Copy the whole installed workspace tree in one shot so
# pnpm's relative symlinks (node_modules/.pnpm + the @meetai/shared link)
# all resolve intact.
FROM node:20-alpine AS runtime
WORKDIR /workspace
COPY --from=deps /workspace ./

WORKDIR /workspace/meetings
EXPOSE 4001
USER node
CMD ["node", "src/server.js"]
