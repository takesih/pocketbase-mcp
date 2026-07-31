# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-01
**Commit:** c773f64
**Branch:** main
**Remote:** https://github.com/takesih/pocketbase-mcp.git

## OVERVIEW
PocketBase MCP server — single-file TypeScript MCP exposing 23 PocketBase tools (collections/records/auth/backup) via dual transport (stdio default + HTTP/SSE). Built on `@modelcontextprotocol/sdk` 0.6.1 + `pocketbase` 0.26.1, Node 20, CommonJS.

## SYNC + DEPLOY MODEL

**Sync (this repo → GitHub):**
```bash
git add -A
git commit -m "<msg>"
git push origin main
```
Then Coolify auto-detects push (if webhook wired) or trigger via `coolify_deploy` tool.

**Deploy (this repo → container):**
- **Primary path: Coolify MCP** — `coolify_list_applications` / `coolify_deploy` / `coolify_get_application` / `coolify_logs`
- **Fallback path: audioanalyze-ssh MCP** — `audioanalyze-ssh_exec` for manual `docker compose up -d` on the dockge host (192.168.1.17, HomeAssistant-registered)

**Dockerfile already clones git at build time** (`ARG REPO_URL=https://github.com/takesih/pocketbase-mcp.git`, line 9). Coolify git-source build only needs push to trigger.

## COOLIFY MCP QUICK REFERENCE

| Tool | Use |
|------|-----|
| `coolify_list_applications` | Find pocketbase-mcp app + uuid |
| `coolify_get_application` (uuid) | Inspect config, env, ports, build_pack |
| `coolify_deploy` (tag_or_uuid) | Trigger redeploy after push |
| `coolify_logs` (uuid, lines=100) | Tail logs after deploy |
| `coolify_env_vars` (list/update) | Manage POCKETBASE_URL / ADMIN creds |
| `coolify_control` (restart) | Restart without full rebuild |
| `coolify_diagnose_app` | Pre-flight health check |

**Build pack required**: `dockerfile` (not `nixpacks` — Dockerfile clones + builds custom)

## STRUCTURE
```
pocketbase-mcp/
├── src/                  # single source file (1010 lines)
├── build/                # tsc output — deployable artifact (gitignored for fresh builds)
├── .github/workflows/    # release.yml only (multi-OS zip + gh-release)
├── Dockerfile            # multi-stage, clones repo at build, runs HTTP/SSE on :80
├── package.json          # bin: pocketbase-server, no engine pin
├── tsconfig.json         # ES2020 strict, outDir=build
├── pnpm-workspace.yaml   # stub (no actual packages — vestigial)
├── .env.example          # POCKETBASE_URL required
└── README.md             # 308 lines, but tool list STALE (9 vs 23 actual)
```

## WHERE TO LOOK
| Task | Location |
|------|----------|
| Add MCP tool | `src/index.ts:148` `setupToolHandlers` (add `<tool_name>` + handler) |
| Auth flow | `src/index.ts:114` `adminAuth` (API key → Basic → email/pwd) |
| Transport mode | `src/index.ts:936` `main()` (stdio default, SSE if `POCKETBASE_HTTP_MODE=true`) |
| SSE config | `src/index.ts:65` `getHeader` + `:79` `configureFromHeaders` |
| Error shaping | `src/index.ts:899` `flattenErrors` / `:930` `pocketbaseErrorMessage` (14 callsites) |
| PocketBase SDK calls | `src/index.ts` only — `this.pb.collection(...).*` and `this.pb.collections.*` |
| Deploy config | `Dockerfile` (clones repo, runs HTTP/SSE :80) |
| Coolify env vars | `coolify_env_vars` MCP tool (actions: list/update) |

## DEPLOY (manual fallback via audioanalyze-ssh)

When Coolify not available or git webhook broken:

```bash
# 1. sync source (if not already pushed)
cd D:\WorkSpace\pocketbase-mcp
git push origin main

# 2. audioanalyze-ssh MCP exec (192.168.1.17, dockge host)
mkdir -p /opt/stacks/pocketbase-mcp
cd /opt/stacks/pocketbase-mcp
git clone https://github.com/takesih/pocketbase-mcp.git .

# 3. create compose.yaml (does NOT exist in repo — must add)
# see COMPOSE section below

# 4. start
docker compose up -d
```

## COMPOSE (port 8090 → container 80)
```yaml
services:
  pocketbase-mcp:
    build: .
    ports:
      - "8090:80"
    environment:
      POCKETBASE_URL: "http://192.168.1.X:8090"  # pb-fc IP, NOT host.docker.internal
      POCKETBASE_ADMIN_EMAIL: "..."
      POCKETBASE_ADMIN_PASSWORD: "..."
      POCKETBASE_HTTP_MODE: "true"   # baked into image already, explicit for safety
    restart: unless-stopped
```

**POCKETBASE_URL gotcha**: `host.docker.internal` fails inside dockge's network. Use actual pb-fc IP (`192.168.1.X`) reachable from container.

## CONVENTIONS
- Single source file, no split modules — keep all MCP tools in `src/index.ts`
- All admin-gated tools must call `this.adminAuth()` first
- All errors wrapped via `pocketbaseErrorMessage(error)` in `McpError(ErrorCode.InternalError, ...)`
- `POCKETBASE_HTTP_MODE=true` is the only way to run via HTTP (dockge/caddy/coolify). stdio for direct LLM clients
- Field ID generator (`generateFieldId`) auto-injects for `create_collection` — never set `created`/`updated` fields manually (PocketBase reserves them)
- Commit messages: `feat:` / `fix(scope):` / `chore:` (see `git log --oneline`)

## ANTI-PATTERNS (THIS PROJECT)
- **NEVER split `src/index.ts`** into multiple files — single-file architecture is intentional
- **NEVER use stdio mode in Coolify/dockge** — no port, host process can't proxy
- **NEVER bake credentials into Dockerfile** — use Coolify env vars or runtime env (Dockerfile line 31 comment)
- **NEVER trust stale README tool list** — it's 9 tools, actual is 23
- **NEVER add `created`/`updated` fields** to `create_collection` schema (already auto-added)
- **NEVER skip `git push` before deploy** — Dockerfile clones from GitHub, local-only changes won't reach container

## UNIQUE STYLES
- HTTP mode is **undocumented** in README — only in code at `src/index.ts:936`
- Dual-transport server = same code path serves both stdio AND SSE clients
- `X-Pocketbase-Url` SSE header allows per-request PB routing (multi-tenant pattern)
- `pnpm-workspace.yaml` exists but is a stub — repo is single-package, pnpm just used for install
- Dockerfile hardcodes upstream repo URL via `ARG REPO_URL` — Coolify can override via build arg

## COMMANDS
```bash
# dev
pnpm install
pnpm run build         # tsc
pnpm run bundle        # esbuild single-file + shebang
pnpm run dev           # tsc -w (watch)
pnpm start             # build + node build/index.js

# sync
git push origin main

# deploy via Coolify MCP
# (see SYNC + DEPLOY MODEL section)

# docker (locally)
docker build -t pocketbase-mcp .
docker run -d --name pocketbase-mcp -e POCKETBASE_URL=http://127.0.0.1:8090 -p 8090:80 pocketbase-mcp

# health check
curl http://localhost:8090/sse   # SSE stream should respond
```

## NOTES
- **compose.yaml does NOT exist** in repo — only in fallback scenario create at `/opt/stacks/pocketbase-mcp/compose.yaml`
- Dockerfile uses `npm` (not pnpm) inside container — works fine, dependencies identical
- `build/` is NOT gitignored effectively — `index.js` present in working tree
- CI builds on 3 OS but does NOT test — only ships build/ artifact
- Recent commit `c773f64` added SSE header-based PB config (replaces env-only config)
- audioanalyze-ssh exec does NOT need sudo for `/opt/stacks/` (dockge user owns it)
- **Coolify already manages this app** — prefer `coolify_*` MCP over manual docker compose
