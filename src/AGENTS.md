# src/ KNOWLEDGE BASE

**Generated:** 2026-08-01

## OVERVIEW
Single source file `src/index.ts` (1010 lines) — entire MCP server. `PocketBaseServer` class + dual-mode bootstrap. No split modules.

## STRUCTURE
```
src/
└── index.ts    # ONLY file — class + 23 tool handlers + main()
```

## WHERE TO LOOK
| Region | Lines | Purpose |
|--------|-------|---------|
| Imports + helpers | 1-29 | `generateFieldId`, `assignFieldIds` |
| `PocketBaseServer` class | 31-893 | Core server, auth, 23 tools |
| `PocketBaseServer.adminAuth` | 114-146 | API key → Basic → email/pwd cascade |
| `PocketBaseServer.setupToolHandlers` | 148-515 | Tool registry + JSON schemas |
| Tool handlers (private methods) | 516-886 | actual `pb.*` calls |
| `PocketBaseServer.run` | 888-892 | stdio bootstrap |
| `flattenErrors` / `pocketbaseErrorMessage` | 899-933 | Error shaping (14 callsites) |
| `main()` | 936-1009 | Stdio vs HTTP/SSE dispatch |
| Auto-run | 1010 | `main()` invocation |

## CONVENTIONS
- Tool handlers always: `try { ... } catch (error) { throw new McpError(ErrorCode.InternalError, \`Failed to X: ${pocketbaseErrorMessage(error)}\`) }`
- Private tool methods named `<verb><Noun>` (`createRecord`, `listCollections`, `backupDatabase`)
- Each admin-gated tool calls `await this.adminAuth()` first thing
- Tool input schemas inline in `setupToolHandlers` — no separate types module
- `configureFromHeaders` sets `sseConfig` once per request, never mutated mid-session

## ANTI-PATTERNS
- **DO NOT** add new tools outside `setupToolHandlers` — schema and handler must register together
- **DO NOT** call `this.pb` without `adminAuth()` on admin tools (e.g., `delete_collection`, `delete_record`, `create_user`)
- **DO NOT** skip `pocketbaseErrorMessage(error)` wrapper — raw error messages leak SDK internals
- **DO NOT** re-implement auth logic inline — always route through `adminAuth()`

## UNIQUE STYLES
- **Single-file monolith** = 23 tools in one `setupToolHandlers` block. Easy to grep, hard to navigate beyond ~500 lines
- Field ID auto-injection (`generateFieldId` → `assignFieldIds`) is unique to `create_collection` — only place fields need IDs
- `import_data` uses `create`/`update`/`upsert` modes — only tool with branch logic per mode
- `confirmEmailChange` and `confirmPasswordReset` accept both token + extra params — others are token-only

## NOTES
- 23 tools registered; README only mentions 9 (stale docs)
- `create_collection` schema has `passwordAuth` block unique to that tool
- `import_data` reuses `create`/`update`/`getFirstListItem` per mode — circular with `upsert` path
- `pocketbaseErrorMessage` recurses on flat arrays → most reliable way to extract PB validation errors
- All async tool methods return `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }` — uniform shape
