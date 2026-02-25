FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
# Prefer clean install, but fallback to `npm install` if `npm ci` fails inside buildkit
RUN npm ci --omit=dev || npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 4001 4010 4020