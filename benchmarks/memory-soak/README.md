# @refpool/benchmark-memory-soak

Empirically compares the **"cache a connection per tenant forever"** anti-pattern
(an unbounded `Map`) against a bounded
[`RefCountedLruPool`](../../packages/core), under a workload of thousands of
distinct tenant keys, recording `process.memoryUsage().rss` (and `heapUsed`)
over time.

Each simulated "connection" owns a real buffer (default 256 KB) so memory
differences are visible in RSS.

## Run

```bash
# from the repo root
pnpm install
pnpm --filter @refpool/benchmark-memory-soak bench
```

`bench` runs `node --expose-gc --import tsx src/index.ts` so RSS reflects
*retained* (non-garbage) memory for a fair comparison.

## Tuning (env vars)

| Var           | Default | Meaning                              |
| ------------- | ------- | ------------------------------------ |
| `SOAK_KEYS`   | `3000`  | distinct tenant keys                 |
| `SOAK_WAVES`  | `4`     | passes over all keys (per strategy)  |
| `SOAK_BUF_KB` | `256`   | buffer weight per simulated conn     |
| `SOAK_MAX`    | `50`    | refpool live-resource ceiling        |

## Output

Written to `results/` (gitignored — reproducible artifacts):

- `results.csv` — columns: `t_ms,strategy,keys_seen,rss_bytes,heap_used_bytes,live_resources`
- `chart.md` — ASCII bar + sparkline chart and a peak-RSS / live-count summary

A summary table (peak RSS unbounded vs pooled, final live count, % reduction) is
also printed to stdout.
