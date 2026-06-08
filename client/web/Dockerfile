# Stage 1: build the static bundle.
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app

# Copy package manifest and the native pnpm lockfile
COPY package.json pnpm-lock.yaml* ./

# Install ALL dependencies (including devDependencies like Vite) 
# using pnpm with frozen lockfile for deterministic builds
RUN pnpm install --frozen-lockfile

# Copy the rest of your source code
COPY . .

# Run the Vite build command (generates the /app/dist folder)
RUN pnpm build

# Stage 2: serve the built assets with nginx.
FROM nginx:alpine
# Copy the built assets from the builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]