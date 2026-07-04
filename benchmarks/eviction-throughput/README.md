# @refpool/benchmark-eviction-throughput

Proves refpool's eviction path is **O(1)** — not just that it bounds memory, but
that the bounding stays cheap as the pool scales.

It pits refpool's intrusive idle-list LRU against the **naive full-scan LRU** a
hand-rolled pool usually reaches for (scan every live entry to find the victim).
Both pools expose the same async `acquire` API and run an identical
eviction-heavy workload (working set = `max × 4`, swept sequentially, so almost
every acquire creates one resource and evicts one). The only difference measured
is the eviction algorithm.

```bash
pnpm bench
# or tune it:
EVICT_MAXES=64,1024,16384,262144 EVICT_OPS=100000 pnpm bench
```

As `max` grows geometrically, refpool holds per-op cost roughly constant
(residual drift is CPU-cache / GC, not algorithmic) while the naive scan degrades
linearly — so the throughput gap widens with scale (single-digit× at small
`max`, 100×+ by tens of thousands of live keys).

Outputs `results/chart.md` (table + throughput bars) and `results/results.csv`.

| Env var | Default | Meaning |
| --- | --- | --- |
| `EVICT_MAXES` | `64,512,4096,32768` | comma-separated `max` ceilings to sweep |
| `EVICT_OPS` | `80000` | timed acquire/release ops per run |
| `EVICT_WARMUP` | `10000` | warmup ops before timing |
| `EVICT_WORKSET_MULT` | `4` | working set = `max ×` this |
