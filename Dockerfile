FROM node:20-alpine AS builder

# Install git to fetch source from remote repository
RUN apk add --no-cache git

WORKDIR /app

# Clone the repository (default to official source) and install dependencies
ARG REPO_URL="https://github.com/takesih/pocketbase-mcp.git"
RUN git clone "$REPO_URL" .

# Install production dependencies and build the project
RUN npm ci --no-fund --no-audit
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
