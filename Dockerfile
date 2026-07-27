FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g npm@latest

COPY package.json package-lock.json* tsconfig.json ./
COPY src/ ./src/

RUN npm install --no-fund --no-audit
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# PocketBase connection URL — safe to bake into image (public endpoint).
ENV POCKETBASE_URL=https://pb-fc.laonflow.xyz

# HTTP/SSE mode (no mcp-proxy wrapper — native SSE in our index.ts)
ENV POCKETBASE_HTTP_MODE=true
ENV PORT=80

EXPOSE 80

# Credentials (POCKETBASE_ADMIN_EMAIL/PASSWORD, POCKETBASE_API_KEY) are injected
# at runtime via Coolify environment variables — NOT baked into the image.
CMD ["node", "build/index.js"]
