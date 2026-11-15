# skywe-forge

A standalone, GitHub-compatible git forge in a single Node.js process —
no UI, no database, no outside services. One in-memory store backs four
surfaces at once, so every object is the same object everywhere:

- **Git smart HTTP** — protocol v0 and v2: `info/refs`, `ls-refs`,
  `fetch` (including shallow clones and deepening), and `receive-pack`
  with fast-forward enforcement and per-ref status reports.
- **REST v3** — repositories (CRUD + pagination), branches, commits,
  git refs, the Contents API, labels, issues and comments, and pull
  requests with changed-file lists and squash merges.
- **GraphQL v4** — viewer/repository/node queries, issue connections with
  cursor pagination, pull requests with mergeability, introspection, and
  the create/close/merge/comment mutations.
- **MCP** — the modern `server/discover` era plus a legacy `initialize`
  fallback, with tools for repositories, issues and pull requests.

Git objects are real git objects: SHA-1 content addressing, standard
commit/tree/tag encodings, and version-2 packfiles in both directions.

## Running

```sh
MAKEFUN_SHOP_TOKEN=<bearer-token> npm start
```

The entrypoint speaks the make.fun harness lifecycle: when
`MAKEFUN_ENV_URL` is set it listens on an ephemeral port, registers with
the environment, and exits when the environment reports the run is done.
Without it, it serves standalone on `PORT` (default 8080). When
`MAKEFUN_SHOP_TOKEN` is set, every surface except `GET /healthz` requires
`Authorization: Bearer <token>`.

## Layout

- `main.ts` — entrypoint and harness lifecycle
- `app.ts` — HTTP composition, auth, request ids, routing
- `forge.ts` — the store and the domain logic shared by all surfaces
- `gitobj.ts` — git object model, packfiles, pkt-line framing
- `githttp.ts` — the smart-HTTP git protocol (v0 + v2)
- `rest.ts` — the REST v3 API
- `graphql.ts` — a small GraphQL engine plus the forge schema
- `mcp.ts` — the MCP JSON-RPC endpoint and its tools

Pure Node.js standard library; TypeScript in the strictly erasable subset
so Node 22 runs it directly with type stripping.
