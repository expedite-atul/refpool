# @refpool/example-generic-http-clients

A **non-DB** demo proving refpool's generic positioning. refpool is not a
database library — it pools *any* keyed, expensive-to-create resource. Here the
resource is a per-(base-URL / API-token) "HTTP client" that owns a keep-alive
`http.Agent`.

Runs fully offline (no network, no external services): the client `call()` is a
stub, the factory stands up an `http.Agent`, and `dispose` tears it down.

## What it demonstrates

- **Refcounting** — two concurrent callers share one client instance; it is only
  reclaimable once both release.
- **Bounded `max`** — churning through many distinct services never holds more
  than `max` live clients.
- **LRU eviction** — the coldest idle client is disposed (its `http.Agent`
  destroyed) when a new key would exceed `max`; re-touching a survivor protects
  it from being the next victim.
- **`getStats()`** — before/after snapshots, plus a leak check that every created
  agent was destroyed.

## Run

```bash
# from the repo root
pnpm install
pnpm --filter @refpool/example-generic-http-clients start
```

(`start` runs `tsx src/index.ts`; it runs to completion and prints a clear stats
summary.)
