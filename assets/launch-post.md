# refpool — LinkedIn launch post

> Attach `assets/hero-memory.mp4` as the post video. Optionally follow up with a
> carousel built from the other four GIFs. Swap the video in as the first media.

---

𝗢𝗻𝗲 𝗹𝗶𝗻𝗲 𝗼𝗳 "𝗼𝗯𝘃𝗶𝗼𝘂𝘀" 𝗺𝘂𝗹𝘁𝗶-𝘁𝗲𝗻𝗮𝗻𝘁 𝗰𝗼𝗱𝗲 𝗹𝗲𝗮𝗸𝗲𝗱 𝗺𝗲𝗺𝗼𝗿𝘆 𝘂𝗻𝘁𝗶𝗹 𝘁𝗵𝗲 𝗱𝗮𝘁𝗮𝗯𝗮𝘀𝗲 𝗿𝗮𝗻 𝗼𝘂𝘁 𝗼𝗳 𝗰𝗼𝗻𝗻𝗲𝗰𝘁𝗶𝗼𝗻𝘀.

So I built the fix, and today I'm open-sourcing it: **refpool**. 👇

Here's the trap 👇

You're multi-tenant. Each tenant needs its own database connection (different DB, different credentials, row-level isolation — pick your reason). So you do the obvious thing:

```
const pools = new Map<string, Pool>();
function getPool(t) { return pools.get(t) ?? create(t); }  // one pool per tenant
```

It demos perfectly. Then production arrives. Tenant #1 through #3,000 each get a live pool — and 𝗻𝗼𝘁𝗵𝗶𝗻𝗴 𝗲𝘃𝗲𝗿 𝗿𝗲𝗺𝗼𝘃𝗲𝘀 𝘁𝗵𝗲𝗺. The Map only grows. Every tenant who ever connected keeps a live pool — sockets, buffers, server-side connections — resident forever. RSS climbs, the DB connection limit gets hit, something falls over.

It's not a leak in the classic sense. It's an **unbounded cache you accidentally promised to keep forever.**

━━━━━━━━━━━━━━━━━━━━

𝗧𝗵𝗲 𝗳𝗶𝘅: 𝗸𝗲𝗲𝗽 𝘁𝗵𝗲 𝘀𝗮𝗺𝗲 `𝗮𝗰𝗾𝘂𝗶𝗿𝗲(𝗸𝗲𝘆)` 𝗲𝗿𝗴𝗼𝗻𝗼𝗺𝗶𝗰𝘀 — 𝗯𝘂𝘁 𝗯𝗼𝘂𝗻𝗱 𝗶𝘁.

**refpool** is a keyed, **reference-counted, bounded LRU resource pool**:

🔹 𝗕𝗼𝘂𝗻𝗱𝗲𝗱 — never hold more than `max` live resources; the coldest *idle* one is evicted.
🔹 𝗥𝗲𝗳𝗲𝗿𝗲𝗻𝗰𝗲-𝗰𝗼𝘂𝗻𝘁𝗲𝗱 — concurrent requests for a tenant share one resource; it's only reclaimable when the *last* holder releases. No request ever has its connection pulled out from under it.
🔹 𝗦𝗲𝗹𝗳-𝗿𝗲𝗰𝗹𝗮𝗶𝗺𝗶𝗻𝗴 — idle-past-TTL resources are swept; a circuit breaker guards a flapping tenant DB.

Same `pool.acquire(key)`. One line changes the memory profile.

━━━━━━━━━━━━━━━━━━━━

"𝗕𝘂𝘁 𝗱𝗼𝗲𝘀𝗻'𝘁 𝗣𝗴𝗕𝗼𝘂𝗻𝗰𝗲𝗿 𝗱𝗼 𝘁𝗵𝗶𝘀?" — 𝗱𝗶𝗳𝗳𝗲𝗿𝗲𝗻𝘁 𝗹𝗮𝘆𝗲𝗿. 𝗨𝘀𝗲 𝗯𝗼𝘁𝗵.

PgBouncer multiplexes many client connections onto **few server connections** — for *one* database, server-side. Brilliant at what it does.

But it can't see the thing that's leaking: the count of **per-tenant client pools inside your Node process** — every `pg.Pool` / `DataSource` / `PrismaClient` you hold. With thousands of tenants on distinct DBs/credentials, or an ORM that owns its own pool, that in-process set still grows unbounded — even with PgBouncer downstream.

refpool bounds the **client layer**; PgBouncer pools the **connection layer**. Point each pooled client *at* PgBouncer and both win.

━━━━━━━━━━━━━━━━━━━━

𝗗𝗼𝗲𝘀 𝗶𝘁 𝗮𝗰𝘁𝘂𝗮𝗹𝗹𝘆 𝗵𝗲𝗹𝗽? (𝗿𝗲𝗮𝗹 𝗻𝘂𝗺𝗯𝗲𝗿𝘀, 𝗿𝗲𝗽𝗿𝗼𝗱𝘂𝗰𝗶𝗯𝗹𝗲)

Same 3,000-tenant workload, unbounded `Map` vs refpool (`max 50`):
✅ **98.3% fewer live connections** (3,000 → 50) — exact and deterministic
✅ **~80% lower peak RSS** (4–5× less memory)
✅ **O(1) eviction** — an intrusive idle-list LRU stays flat as `max` scales; up to **~150× faster** than the naive full-scan LRU at tens of thousands of keys

And the engineering around it:
🔸 Zero-runtime-dependency core
🔸 Adapters for **node-postgres, TypeORM, Drizzle, Prisma, Knex** + a **NestJS** module (per-tenant middleware, health route)
🔸 First-class observability — **Prometheus / OpenTelemetry** metrics + a **Grafana** dashboard

━━━━━━━━━━━━━━━━━━━━

It's **MIT-licensed and open source** — `@refpool/*` on npm.

If you've ever `new Map()`-cached a connection per tenant and hoped for the best, this is the thing I wish I'd had.

⭐ **Repo:** github.com/expedite-atul/refpool
🧰 More of my work: **atulsingh.io**

What's your multi-tenant connection strategy today — pool-per-tenant, shared pool + SET search_path, or something else? Curious what's worked (and what's burned you).

#SoftwareEngineering #NodeJS #DistributedSystems #Postgres #OpenSource #Backend #SystemDesign #MultiTenancy
