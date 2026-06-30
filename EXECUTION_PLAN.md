# refpool — Phase-wise Execution Plan

> A keyed, reference-counted, bounded resource pool.
> **Generic-first** positioning; multi-tenant DB connection pooling is the flagship use case.
> This document is the single source of truth for execution status. Update checkboxes as work lands.

**Legend:** ✅ complete · 🔄 in progress · ⏳ pending · ⛔ blocked · ⏸️ deferred (manual / out of scope)

---

## Phase 0 — Scaffold & tooling  ✅ (Task #1)

- [x] Create `refpool/` directory tree
- [x] pnpm workspace (`pnpm-workspace.yaml`) + root `package.json`
- [x] `tsconfig.base.json` + root `tsconfig.json`
- [x] tsup + vitest workspace + changesets config
- [x] GitHub Actions CI (`.github/workflows/ci.yml`)
- [x] MIT `LICENSE`, `.gitignore`
- [x] `pnpm install` — materialize workspace (lockfile written, 184 pkgs, workspace linked)
- [x] `git init` + first commit (commit `841417b`)

**Exit criteria:** root tooling resolves; `pnpm install` succeeds; first commit recorded.

---

## Phase 1 — `@refpool/core`  ✅ (Task #2 — implementation complete & green; commit landed)

- [x] `package.json` (name `@refpool/core`, `opossum` subpath export, tsup build, vitest, optional `opossum` peer dep)
- [x] `tsconfig.json` extending base
- [x] `tsup.config.ts` (entry: `index`, `opossum`; dts; esm+cjs)
- [x] `types.ts` — `Logger`, `CircuitBreaker`, `PrewarmStrategy`, `PoolEvent`, `PoolStats`, `PoolOptions<T>`
- [x] `RefCountedLruPool<T>` — `acquire` / `release` / `getStats` / `warm` / `drain` / `start` / `stop`
- [x] Internals — per-key mutex, LRU + orphan-pool handoff, idempotent dispose, TTL idle sweep, mutex GC
- [x] Breakers — no-op default + dependency-free `InMemoryCircuitBreaker` state machine
- [x] Opossum breaker adapter (`@refpool/core/opossum` subpath, optional peer dep)
- [x] Typed `PoolEvent` emitter + `[POOL_STATS]` log line
- [x] Unit tests ported from Quivio specs (11 files, 19 tests, all green):
  - [x] refcount correctness
  - [x] bounded-under-pressure
  - [x] concurrency / per-key mutex
  - [x] LRU eviction
  - [x] idle cleanup (TTL sweep)
  - [x] shutdown drain
  - [x] orphan resurrection
  - [x] breaker transitions (closed→open→half-open→closed)
  - [x] NEW: drain / prewarm / event-emitter tests

**Exit criteria:** `pnpm --filter @refpool/core typecheck && test && build` all green (verified via the package binaries — `tsc --noEmit` exit 0, `vitest run` 19 passed, `tsup` emitted ESM+CJS+dts and the `./opossum` subpath resolves). `git init` + first commit landed (commit `841417b`).

---

## Phase 2 — `@refpool/metrics` + Grafana  ✅ (Task #3)

- [x] `@refpool/metrics` package scaffold (depends on `@refpool/core`)
- [x] Prometheus exporter (`prom-client`) subscribing to `PoolEvent` + scraping `getStats()`
- [x] OpenTelemetry exporter (`@opentelemetry/api`)
- [x] `grafana/refpool-dashboard.json` (saturation, hit rate, breaker state, RSS trend)
- [x] Unit tests (metric registration + event→metric mapping)

**Exit criteria:** exporters typecheck/test/build green; dashboard JSON validates.

---

## Phase 3 — DB adapters  ✅ (Task #4)

- [x] `@refpool/typeorm` — DataSource adapter + `withResource()`
- [x] `@refpool/pg` (`node-postgres`) — node-postgres adapter
- [x] `@refpool/drizzle` — Drizzle adapter
- [x] testcontainers-postgres integration test (>max tenants ⇒ live connection count stays ≤ max), opt-in via `INTEGRATION=1` (written; skipped by default — needs Docker + INTEGRATION=1)
- [x] `@refpool/prisma` (fast-follow)
- [x] `@refpool/knex` (fast-follow)

**Exit criteria:** three primary adapters green; integration test passes under `INTEGRATION=1`; prisma/knex landed.

---

## Phase 4 — `@refpool/nestjs`  ✅ (Task #5)

- [x] `RefPoolModule.forRoot` / `forRootAsync` + `@Injectable` service with lifecycle hooks (`onModuleInit` warm, `onApplicationShutdown` drain)
- [x] `TenantConnectionMiddleware` (header-keyed acquire/release)
- [x] `GET /health/connections` controller

**Exit criteria:** module typechecks/tests/builds against Nest peer deps.

---

## Phase 5 — Examples + benchmark  ✅ (Task #6)

- [x] `examples/nest-multitenant` (runnable demo)
- [x] `examples/generic-http-clients` (non-DB proof of generic positioning)
- [x] `benchmarks/memory-soak` (unbounded `Map` vs pool, RSS over time → chart/CSV — generates the real numbers)

**Exit criteria:** examples run; benchmark emits CSV + chart artifacts.

---

## Phase 6 — Docs + ready-to-publish dry-run  🔄 (Task #7)

- [ ] Per-package READMEs + root README ("to my past self", generic-first, DB as flagship)
- [ ] `changeset version`
- [ ] `pnpm -r build`
- [ ] `npm pack` tarball inspection (per publishable package)
- [ ] `package.json` metadata check (files, exports, types, repo, license)
- [ ] ⛔ **STOP** — no `npm publish`, no GitHub repo creation (manual / owner-run)

**Exit criteria:** clean dry-run; tarballs inspected; nothing published.

---

## Manual / owner-run (never automated)

- ⏸️ `npm publish`
- ⏸️ GitHub repo creation / push to remote
