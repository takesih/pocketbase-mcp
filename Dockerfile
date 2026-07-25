FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm

# Source is already checked out by Coolify into the build context
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src/ ./src/

RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

RUN npm install -g mcp-proxy

EXPOSE 80

ENV POCKETBASE_URL=https://pb-fc.laonflow.xyz
ENV POCKETBASE_ADMIN_EMAIL=
ENV POCKETBASE_ADMIN_PASSWORD=

CMD ["sh", "-c", "mcp-proxy --sse --host 0.0.0.0 --port 80 -- node build/index.js"]
