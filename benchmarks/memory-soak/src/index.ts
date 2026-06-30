/**
 * Memory soak benchmark — the anti-pattern vs refpool.
 *
 * The naive way to give every tenant its own connection is to cache it in a
 * plain `Map` and never let go:
 *
 *     const perTenant = new Map<string, Conn>();
 *     function get(t) { return perTenant.get(t) ?? perTenant.set(t, open(t)).get(t); }
 *
 * That `Map` grows without bound: one live connection per tenant, forever. Under
 * a workload of thousands of distinct tenants this is a slow-motion memory leak.
 *
 * refpool's `RefCountedLruPool` keeps the SAME ergonomics (acquire by key) but
 * caps the number of *live* resources at `max` and disposes the cold ones. This
 * benchmark drives an identical workload through both strategies, samples
 * `process.memoryUsage()` over time, writes a CSV + an ASCII chart, and prints a
 * summary table with the real RSS reduction.
 *
 * Run:  node --expose-gc --import tsx src/index.ts     (or: pnpm bench)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RefCountedLruPool } from '@refpool/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, '..', 'results');

// ---------------------------------------------------------------------------
// Config (env-overridable so you can crank it up locally)
// ---------------------------------------------------------------------------
const KEYS = Number(process.env.SOAK_KEYS ?? 3_000); // distinct tenants
const WAVES = Number(process.env.SOAK_WAVES ?? 4); // passes over all tenants
const BUF_KB = Number(process.env.SOAK_BUF_KB ?? 256); // "weight" of one connection
const MAX = Number(process.env.SOAK_MAX ?? 50); // refpool live ceiling
const BUF_BYTES = BUF_KB * 1024;
const TOTAL_OPS = KEYS * WAVES;
const SAMPLE_EVERY = Math.max(1, Math.floor(TOTAL_OPS / 120));

const gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc;

// ---------------------------------------------------------------------------
// The simulated heavy resource: a "connection" that owns a real buffer so its
// weight is visible in RSS (Node allocates large Buffers off the V8 heap).
// ---------------------------------------------------------------------------
interface FakeConn {
  key: string;
  buf: Uint8Array | null;
  destroyed: boolean;
}

function createConn(key: string): FakeConn {
  // Fill the WHOLE buffer: untouched pages of a fresh allocation are backed by
  // shared zero pages and don't count toward RSS until written. Filling forces
  // every page resident so RSS reflects the true weight of a live connection.
  const buf = new Uint8Array(BUF_BYTES);
  buf.fill((key.length + 1) & 0xff);
  return { key, buf, destroyed: false };
}

function destroyConn(conn: FakeConn): void {
  conn.destroyed = true;
  conn.buf = null; // drop the heavy reference so it becomes collectible
}

function touch(conn: FakeConn): void {
  // Simulate "using" the connection for one request.
  if (conn.buf) conn.buf[1] = (conn.buf[1]! + 1) & 0xff;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------
interface Sample {
  tMs: number;
  strategy: 'unbounded' | 'pooled';
  keysSeen: number;
  rss: number;
  heapUsed: number;
  live: number;
}

const samples: Sample[] = [];
let t0 = 0;

function record(strategy: Sample['strategy'], keysSeen: number, live: number): void {
  // gc before sampling so RSS reflects *retained* memory, not uncollected
  // garbage — this is the fair, apples-to-apples comparison for both strategies.
  gc?.();
  const m = process.memoryUsage();
  samples.push({
    tMs: Math.round(performance.now() - t0),
    strategy,
    keysSeen,
    rss: m.rss,
    heapUsed: m.heapUsed,
    live,
  });
}

// ---------------------------------------------------------------------------
// Strategy 1 — unbounded Map (the anti-pattern)
// ---------------------------------------------------------------------------
function runUnbounded(): { finalLive: number } {
  const cache = new Map<string, FakeConn>();
  let keysSeen = 0;
  for (let w = 0; w < WAVES; w += 1) {
    for (let i = 0; i < KEYS; i += 1) {
      const key = `tenant-${i}`;
      let conn = cache.get(key);
      if (!conn) {
        conn = createConn(key);
        cache.set(key, conn); // never evicted -> grows to KEYS and stays there
      }
      touch(conn);
      keysSeen += 1;
      if (keysSeen % SAMPLE_EVERY === 0) record('unbounded', keysSeen, cache.size);
    }
  }
  const finalLive = cache.size;
  record('unbounded', keysSeen, finalLive);
  return { finalLive };
}

// ---------------------------------------------------------------------------
// Strategy 2 — bounded RefCountedLruPool
// ---------------------------------------------------------------------------
async function runPooled(): Promise<{ finalLive: number }> {
  const pool = new RefCountedLruPool<FakeConn>({
    max: MAX,
    factory: async (key) => createConn(key),
    dispose: (conn) => destroyConn(conn),
  });
  pool.start();

  let keysSeen = 0;
  for (let w = 0; w < WAVES; w += 1) {
    for (let i = 0; i < KEYS; i += 1) {
      const key = `tenant-${i}`;
      const handle = await pool.acquire(key); // borrow
      touch(handle.resource);
      handle.release(); // return immediately (typical per-request lifecycle)
      keysSeen += 1;
      if (keysSeen % SAMPLE_EVERY === 0) record('pooled', keysSeen, pool.getStats().live);
    }
  }
  const finalLive = pool.getStats().live;
  record('pooled', keysSeen, finalLive);
  await pool.drain();
  return { finalLive };
}

// ---------------------------------------------------------------------------
// Output: CSV + ASCII chart + summary
// ---------------------------------------------------------------------------
const MB = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 100) / 100;

function writeCsv(): string {
  const header = 't_ms,strategy,keys_seen,rss_bytes,heap_used_bytes,live_resources';
  const lines = samples.map(
    (s) => `${s.tMs},${s.strategy},${s.keysSeen},${s.rss},${s.heapUsed},${s.live}`,
  );
  const csv = [header, ...lines].join('\n') + '\n';
  const path = join(RESULTS_DIR, 'results.csv');
  writeFileSync(path, csv);
  return path;
}

function bar(value: number, max: number, width = 48): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, width - filled));
}

function sparkline(series: number[], globalMax: number, points = 48): string {
  const blocks = ' ▁▂▃▄▅▆▇█';
  if (series.length === 0) return '';
  // Downsample to `points` buckets (max within each bucket).
  const out: string[] = [];
  for (let p = 0; p < points; p += 1) {
    const start = Math.floor((p * series.length) / points);
    const end = Math.max(start + 1, Math.floor(((p + 1) * series.length) / points));
    let bucketMax = 0;
    for (let i = start; i < end && i < series.length; i += 1) {
      bucketMax = Math.max(bucketMax, series[i]!);
    }
    const idx = globalMax > 0 ? Math.round((bucketMax / globalMax) * (blocks.length - 1)) : 0;
    out.push(blocks[idx]!);
  }
  return out.join('');
}

function writeChart(stats: Summary): string {
  const unboundedRss = samples.filter((s) => s.strategy === 'unbounded').map((s) => s.rss);
  const pooledRss = samples.filter((s) => s.strategy === 'pooled').map((s) => s.rss);
  const globalMax = Math.max(stats.peakUnboundedRss, stats.peakPooledRss);

  const lines = [
    '# Memory soak — unbounded `Map` vs bounded `RefCountedLruPool`',
    '',
    '## Configuration',
    '',
    `- Distinct tenant keys: **${KEYS.toLocaleString()}**`,
    `- Waves (passes over all keys): **${WAVES}** (total ${TOTAL_OPS.toLocaleString()} ops/strategy)`,
    `- Resource weight per connection: **${BUF_KB} KB**`,
    `- refpool \`max\` live resources: **${MAX}**`,
    `- \`global.gc\` available: **${gc ? 'yes (--expose-gc)' : 'no'}**`,
    '',
    '## Peak RSS',
    '',
    '```',
    `unbounded  ${bar(stats.peakUnboundedRss, globalMax)}  ${MB(stats.peakUnboundedRss)} MB`,
    `pooled     ${bar(stats.peakPooledRss, globalMax)}  ${MB(stats.peakPooledRss)} MB`,
    '```',
    '',
    `**RSS reduction with refpool: ${stats.rssReductionPct.toFixed(1)}%**`,
    '',
    '## RSS over time (each strategy, scaled to the global peak)',
    '',
    '```',
    `unbounded ${sparkline(unboundedRss, globalMax)}`,
    `pooled    ${sparkline(pooledRss, globalMax)}`,
    `          ${' '.repeat(0)}start${' '.repeat(34)}end`,
    '```',
    '',
    '## Live resources retained at end',
    '',
    `- unbounded: **${stats.finalLiveUnbounded.toLocaleString()}** live connections (one per tenant, forever)`,
    `- pooled: **${stats.finalLivePooled.toLocaleString()}** live connections (bounded by \`max\`)`,
    '',
    `_Generated by \`@refpool/benchmark-memory-soak\`. CSV: \`results.csv\`._`,
    '',
  ];
  const md = lines.join('\n');
  const path = join(RESULTS_DIR, 'chart.md');
  writeFileSync(path, md);
  return path;
}

interface Summary {
  peakUnboundedRss: number;
  peakPooledRss: number;
  peakUnboundedHeap: number;
  peakPooledHeap: number;
  finalLiveUnbounded: number;
  finalLivePooled: number;
  rssReductionPct: number;
}

function summarize(finalLiveUnbounded: number, finalLivePooled: number): Summary {
  const peak = (strategy: Sample['strategy'], field: 'rss' | 'heapUsed'): number =>
    samples
      .filter((s) => s.strategy === strategy)
      .reduce((m, s) => Math.max(m, s[field]), 0);

  const peakUnboundedRss = peak('unbounded', 'rss');
  const peakPooledRss = peak('pooled', 'rss');
  return {
    peakUnboundedRss,
    peakPooledRss,
    peakUnboundedHeap: peak('unbounded', 'heapUsed'),
    peakPooledHeap: peak('pooled', 'heapUsed'),
    finalLiveUnbounded,
    finalLivePooled,
    rssReductionPct:
      peakUnboundedRss > 0 ? ((peakUnboundedRss - peakPooledRss) / peakUnboundedRss) * 100 : 0,
  };
}

function printSummary(s: Summary, csvPath: string, chartPath: string): void {
  const row = (label: string, a: string, b: string): string =>
    `  ${label.padEnd(26)} ${a.padStart(16)} ${b.padStart(16)}`;
  console.log('\n================ MEMORY SOAK RESULTS ================');
  console.log(
    `  workload: ${KEYS.toLocaleString()} keys x ${WAVES} waves, ${BUF_KB}KB/conn, refpool max=${MAX}`,
  );
  console.log('  ' + '-'.repeat(60));
  console.log(row('metric', 'unbounded Map', 'refpool pool'));
  console.log('  ' + '-'.repeat(60));
  console.log(row('peak RSS', `${MB(s.peakUnboundedRss)} MB`, `${MB(s.peakPooledRss)} MB`));
  console.log(
    row('peak heapUsed', `${MB(s.peakUnboundedHeap)} MB`, `${MB(s.peakPooledHeap)} MB`),
  );
  console.log(
    row(
      'final live resources',
      s.finalLiveUnbounded.toLocaleString(),
      s.finalLivePooled.toLocaleString(),
    ),
  );
  console.log('  ' + '-'.repeat(60));
  console.log(`  peak RSS reduction with refpool : ${s.rssReductionPct.toFixed(1)}%`);
  console.log(
    `  live-resource reduction         : ${(
      ((s.finalLiveUnbounded - s.finalLivePooled) / Math.max(1, s.finalLiveUnbounded)) *
      100
    ).toFixed(1)}%`,
  );
  console.log('  ' + '-'.repeat(60));
  console.log(`  CSV   : ${csvPath}`);
  console.log(`  chart : ${chartPath}`);
  console.log('====================================================\n');
}

// ---------------------------------------------------------------------------
// Child mode: run exactly ONE strategy in this (fresh) process and emit its
// samples as a JSON sentinel on stdout. Running each strategy in its own process
// is essential: RSS is a sticky, process-global high-water mark, so measuring
// both strategies in one process would let phase 1's peak contaminate phase 2.
// ---------------------------------------------------------------------------
const RESULT_PREFIX = '__SOAK_RESULT__';

async function runChild(strategy: Sample['strategy']): Promise<void> {
  t0 = performance.now();
  const finalLive =
    strategy === 'unbounded' ? runUnbounded().finalLive : (await runPooled()).finalLive;
  // Human-readable progress goes to stderr; stdout carries only the result line.
  process.stderr.write(`    [${strategy}] done — finalLive=${finalLive}\n`);
  process.stdout.write(RESULT_PREFIX + JSON.stringify({ strategy, finalLive, samples }) + '\n');
}

interface ChildResult {
  strategy: Sample['strategy'];
  finalLive: number;
  samples: Sample[];
}

function spawnPhase(strategy: Sample['strategy'], scriptPath: string): ChildResult {
  const execArgv = [...process.execArgv];
  if (!execArgv.includes('--expose-gc')) execArgv.push('--expose-gc');
  const child = spawnSync(
    process.execPath,
    [...execArgv, scriptPath, `--phase=${strategy}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env },
  );
  if (child.status !== 0) {
    throw new Error(`child phase "${strategy}" exited with status ${child.status}`);
  }
  const line = (child.stdout ?? '')
    .split('\n')
    .find((l) => l.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`child phase "${strategy}" produced no result`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as ChildResult;
}

// ---------------------------------------------------------------------------
// Orchestrator mode: spawn one fresh process per strategy, merge their samples,
// then write the CSV + chart and print the summary.
// ---------------------------------------------------------------------------
function runOrchestrator(scriptPath: string): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  console.log('refpool memory-soak benchmark');
  console.log(
    `  keys=${KEYS} waves=${WAVES} bufKB=${BUF_KB} max=${MAX} gc=${gc ? 'on' : 'off'}`,
  );
  if (!gc) {
    console.log('  (tip: run with --expose-gc for steadier RSS — pnpm bench does this)');
  }
  console.log('  phase 1/2: unbounded Map (fresh process) ...');
  const unbounded = spawnPhase('unbounded', scriptPath);
  console.log('  phase 2/2: bounded RefCountedLruPool (fresh process) ...');
  const pooled = spawnPhase('pooled', scriptPath);

  samples.length = 0;
  samples.push(...unbounded.samples, ...pooled.samples);

  const summary = summarize(unbounded.finalLive, pooled.finalLive);
  const csvPath = writeCsv();
  const chartPath = writeChart(summary);
  printSummary(summary, csvPath, chartPath);
}

async function main(): Promise<void> {
  const scriptPath = fileURLToPath(import.meta.url);
  const phaseArg = process.argv.find((a) => a.startsWith('--phase='));
  if (phaseArg) {
    const strategy = phaseArg.slice('--phase='.length);
    if (strategy !== 'unbounded' && strategy !== 'pooled') {
      throw new Error(`unknown --phase=${strategy}`);
    }
    await runChild(strategy);
    return;
  }
  runOrchestrator(scriptPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
