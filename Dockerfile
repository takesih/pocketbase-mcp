FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git pnpm

# Clone takesih/pocketbase-mcp (our fork with all 24 tools + fixes)
RUN git clone --depth 1 https://github.com/takesih/pocketbase-mcp.git /tmp/pb
RUN cp -r /tmp/pb/. /app/

# PATCH: upstream misses admin auth on record ops -> listRule-closed collections return 0.
# Inject _superusers auth at the start of list/create/update/delete handlers.
RUN cat > /patch.js <<'EOF'
const fs=require('fs');
let s=fs.readFileSync('src/index.ts','utf8');
const a='      await this.pb.collection("_superusers").authWithPassword(process.env.POCKETBASE_ADMIN_EMAIL ?? "", process.env.POCKETBASE_ADMIN_PASSWORD ?? "");';
for(const fn of ['listRecords','createRecord','updateRecord','deleteRecord']){
  const sig='private async '+fn+'(args: any) {';
  if(s.includes(sig)){
    const i=s.indexOf(sig);
    const a1=s.indexOf('\n',i);
    const a2=s.indexOf('\n',a1+1);
    s=s.slice(0,a2+1)+a+'\n'+s.slice(a2+1);
  }
}
fs.writeFileSync('src/index.ts',s);
EOF
RUN node /patch.js

RUN pnpm install --frozen-lockfile && pnpm run build

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

RUN npm install -g mcp-proxy

EXPOSE 80

ENV POCKETBASE_URL=https://pb-fc.laonflow.xyz
ENV POCKETBASE_ADMIN_EMAIL=""
ENV POCKETBASE_ADMIN_PASSWORD=""

CMD ["sh", "-c", "mcp-proxy --sse --host 0.0.0.0 --port 80 -- node build/index.js"]
