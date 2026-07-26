FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src/ ./src/

RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# PocketBase connection credentials (used by MCP server internally)
ENV POCKETBASE_URL=https://pb-fc.laonflow.xyz
ENV POCKETBASE_ADMIN_EMAIL=takesih@naver.com
ENV POCKETBASE_ADMIN_PASSWORD=chjCYN8596*+
ENV POCKETBASE_API_KEY=mcp-pb-secret-key-2024

# HTTP/SSE mode
ENV POCKETBASE_HTTP_MODE=true
ENV PORT=80

EXPOSE 80

CMD ["node", "build/index.js"]
