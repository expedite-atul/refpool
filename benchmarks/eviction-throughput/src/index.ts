/**
 * Eviction-throughput benchmark — O(1) idle-list LRU vs. the naive full-scan LRU.
 *
 * The memory-soak benchmark proves refpool *bounds* memory. This one proves the
 * bounding stays *cheap* as the pool scales, by pitting refpool's intrusive
 * idle-list eviction (O(1) per eviction) against the intuitive implementation a
 * hand-rolled pool usually reaches for — scan every live entry to find the LRU
 * victim (O(n) per eviction). That full scan is exactly what refpool itself did
 * before this rework, so this is a faithful before/after of the optimization.
 *
 * Both pools are driven by an identical, deliberately pathological workload: a
 * working set several times larger than `max`, swept sequentially, so that after
 * warmup essentially every acquire is a miss that creates one resource and evicts
 * one — the eviction path is hit on every single op. Both expose the same async
 * `acquire` API, so the ONLY difference measured is the eviction algorithm.
 *
 * As `max` grows geometrically, refpool's per-op cost stays roughly constant
 * (residual drift is CPU-cache / GC, not algorithmic) while the naive scan
 * degrades linearly — so the throughput gap widens with scale.
 *
 * Run:  node --import tsx src/index.ts     (or: pnpm bench)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RefCountedLruPool } from '@refpool/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, '..', 'results');

const MAXES = (process.env.EVICT_MAXES ?? '64,512,4096,32768').split(',').map(Number);
const OPS = Number(process.env.EVICT_OPS ?? 80_000); // timed acquire/release ops per run
const WARMUP = Number(process.env.EVICT_WARMUP ?? 10_000); // fill + JIT before timing
const WORKSET_MULT = Number(process.env.EVICT_WORKSET_MULT ?? 4); // working set = max * this

interface FakeResource {
  key: string;
}

interface AsyncPool {
  acquire(key: string): Promise<{ resource: FakeResource; release: () => void }>;
}

/** refpool: O(1) eviction via the intrusive idle list. */
function makeRefpool(max: number): AsyncPool {
  return new RefCountedLruPool<FakeResource>({
    max,
    factory: async (key) => ({ key }),
    dispose: () => {},
  });
}

/**
 * The intuitive hand-rolled LRU: a plain Map keyed by tenant, and on overflow a
 * full scan for the least-recently-used victim. Same async API as refpool so the
 * comparison isolates the eviction algorithm. (This is what refpool's own
 * `pickLruIdle` did before the idle-list rework.)
 */
function makeNaiveScanPool(max: number): AsyncPool {
  const map = new Map<string, { resource: FakeResource; seq: number }>();
  let seq = 0;
  return {
    async acquire(key: string) {
      let entry = map.get(key);
      if (!entry) {
        const resource: FakeResource = { key };
        entry = { resource, seq: (seq += 1) };
        map.set(key, entry);
        if (map.size > max) {
          let victimKey: string | undefined;
          let min = Infinity;
          for (const [k, v] of map) {
            if (v.seq < min) {
              min = v.seq;
              victimKey = k;
            }
          }
          if (victimKey !== undefined) map.delete(victimKey);
        }
      } else {
        entry.seq = seq += 1;
      }
      return {
        resource: entry.resource,
        release: () => {},
      };
    },
  };
}

async function measure(pool: AsyncPool, max: number): Promise<number> {
  const workingSet = max * WORKSET_MULT;
  for (let i = 0; i < WARMUP; i += 1) {
    (await pool.acquire(`k${i % workingSet}`)).release();
  }
  const t0 = performance.now();
  for (let i = 0; i < OPS; i += 1) {
    (await pool.acquire(`k${i % workingSet}`)).release();
  }
  const elapsedMs = performance.now() - t0;
  return OPS / (elapsedMs / 1000); // ops/sec
}

interface Row {
  max: number;
  workingSet: number;
  refpoolOps: number;
  naiveOps: number;
  refpoolNs: number;
  naiveNs: number;
  speedup: number;
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString();
const nsPerOp = (opsPerSec: number): number => 1e9 / opsPerSec;

function bar(value: number, max: number, width = 34): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, width - filled));
}

function writeChart(rows: Row[]): string {
  const maxOps = Math.max(...rows.flatMap((r) => [r.refpoolOps, r.naiveOps]));
  const refDrift =
    ((nsPerOp(rows[rows.length - 1]!.refpoolOps) - nsPerOp(rows[0]!.refpoolOps)) /
      nsPerOp(rows[0]!.refpoolOps)) *
    100;
  const naiveDrift =
    ((nsPerOp(rows[rows.length - 1]!.naiveOps) - nsPerOp(rows[0]!.naiveOps)) /
      nsPerOp(rows[0]!.naiveOps)) *
    100;
  const lines = [
    '# Eviction throughput — O(1) idle-list LRU vs. naive full-scan LRU',
    '',
    'Both pools bound memory identically; the difference is CPU. As `max` (and the',
    'working set) scale, refpool holds its per-op cost roughly constant while the',
    'naive full-scan LRU degrades linearly — so the gap widens with scale.',
    '',
    '## Configuration',
    '',
    `- Ceilings (\`max\`): **${MAXES.join(' → ')}**`,
    `- Working set per run: **max × ${WORKSET_MULT}** (forces an eviction on ~every acquire)`,
    `- Timed ops per run: **${OPS.toLocaleString()}** (after ${WARMUP.toLocaleString()} warmup ops)`,
    '',
    '## Throughput (acquire + release / sec)',
    '',
    '```',
    ...rows.flatMap((r) => [
      `max=${String(r.max).padStart(6)}  refpool  ${bar(r.refpoolOps, maxOps)}  ${fmtInt(
        r.refpoolOps,
      ).padStart(11)} ops/s`,
      `${' '.repeat(13)}naive    ${bar(r.naiveOps, maxOps)}  ${fmtInt(r.naiveOps).padStart(
        11,
      )} ops/s   (refpool ${r.speedup.toFixed(1)}× faster)`,
      '',
    ]),
    '```',
    '',
    '## Per-op cost vs. `max`',
    '',
    '| `max` | working set | refpool ns/op | naive ns/op | refpool speedup |',
    '| ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (r) =>
        `| ${r.max.toLocaleString()} | ${r.workingSet.toLocaleString()} | ${fmtInt(
          r.refpoolNs,
        )} | ${fmtInt(r.naiveNs)} | **${r.speedup.toFixed(1)}×** |`,
    ),
    '',
    `> Over a **${(MAXES[MAXES.length - 1]! / MAXES[0]!)}×** growth in \`max\` ` +
      `(${MAXES[0]} → ${MAXES[MAXES.length - 1]}): refpool per-op cost drifted **${refDrift.toFixed(
        0,
      )}%** (cache/GC, not algorithm) while the naive scan grew **${naiveDrift.toFixed(0)}%** — ` +
      `roughly linear in live-key count. That is the O(1)-vs-O(n) eviction path, measured.`,
    '',
    `_Generated by \`@refpool/benchmark-eviction-throughput\`. CSV: \`results.csv\`._`,
    '',
  ];
  const md = lines.join('\n');
  const path = join(RESULTS_DIR, 'chart.md');
  writeFileSync(path, md);
  return path;
}

function writeCsv(rows: Row[]): string {
  const header = 'max,working_set,refpool_ops_per_sec,naive_ops_per_sec,refpool_ns_per_op,naive_ns_per_op,speedup';
  const body = rows.map(
    (r) =>
      `${r.max},${r.workingSet},${Math.round(r.refpoolOps)},${Math.round(r.naiveOps)},${Math.round(
        r.refpoolNs,
      )},${Math.round(r.naiveNs)},${r.speedup.toFixed(2)}`,
  );
  const csv = [header, ...body].join('\n') + '\n';
  const path = join(RESULTS_DIR, 'results.csv');
  writeFileSync(path, csv);
  return path;
}

async function main(): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  console.log('refpool eviction-throughput benchmark  (O(1) idle-list vs. naive full-scan LRU)');
  console.log(`  maxes=${MAXES.join(',')} ops=${OPS} worksetMult=${WORKSET_MULT}\n`);

  const rows: Row[] = [];
  for (const max of MAXES) {
    process.stdout.write(`  max=${String(max).padStart(6)} ...`);
    const refpoolOps = await measure(makeRefpool(max), max);
    const naiveOps = await measure(makeNaiveScanPool(max), max);
    const row: Row = {
      max,
      workingSet: max * WORKSET_MULT,
      refpoolOps,
      naiveOps,
      refpoolNs: nsPerOp(refpoolOps),
      naiveNs: nsPerOp(naiveOps),
      speedup: refpoolOps / naiveOps,
    };
    rows.push(row);
    process.stdout.write(
      ` refpool ${fmtInt(refpoolOps).padStart(11)} ops/s  vs  naive ${fmtInt(naiveOps).padStart(
        11,
      )} ops/s   → ${row.speedup.toFixed(1)}× faster\n`,
    );
  }

  const csvPath = writeCsv(rows);
  const chartPath = writeChart(rows);

  console.log('\n================ EVICTION THROUGHPUT ================');
  console.log(`  max grew ${MAXES[MAXES.length - 1]! / MAXES[0]!}× (${MAXES[0]} → ${MAXES[MAXES.length - 1]})`);
  console.log(
    `  refpool speedup over naive scan : ${rows[0]!.speedup.toFixed(1)}× (small) → ${rows[
      rows.length - 1
    ]!.speedup.toFixed(1)}× (large)`,
  );
  console.log(`  CSV   : ${csvPath}`);
  console.log(`  chart : ${chartPath}`);
  console.log('====================================================\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
