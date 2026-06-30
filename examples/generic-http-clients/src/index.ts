/**
 * refpool generic positioning demo — no DB, no network.
 *
 * refpool is NOT a database library. It is a keyed, reference-counted, bounded
 * LRU pool for *any* expensive-to-create, keyed resource. Here the resource is
 * a per-(base-URL + token) "HTTP client": an object that owns a keep-alive
 * `http.Agent`. Creating one is "expensive" (sockets, TLS state, config), so we
 * want to reuse them across requests but never let an unbounded number pile up.
 *
 * Everything runs offline: we never send a request, we just stand the clients up
 * and tear them down so you can watch refcounting, the `max` ceiling, and LRU
 * eviction in action via `getStats()`.
 */
import { Agent } from 'node:http';
import { RefCountedLruPool } from '@refpool/core';
import type { PoolStats } from '@refpool/core';

/** A stub "HTTP client" — the kind of object you'd reuse across many calls. */
interface HttpClient {
  readonly baseUrl: string;
  readonly agent: Agent;
  requests: number;
  /** Stand-in for `client.get(path)` — does no network I/O in this demo. */
  call(path: string): { client: string; path: string; reusedSockets: boolean };
}

let createdAgents = 0;
let destroyedAgents = 0;

function createClient(key: string): HttpClient {
  // Each client owns a keep-alive agent; this is the "expensive" part we pool.
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  createdAgents += 1;
  return {
    baseUrl: key,
    agent,
    requests: 0,
    call(path: string) {
      this.requests += 1;
      return { client: key, path, reusedSockets: true };
    },
  };
}

function disposeClient(client: HttpClient): void {
  // Tear down the keep-alive sockets so we don't leak file descriptors.
  client.agent.destroy();
  destroyedAgents += 1;
}

function printStats(label: string, stats: PoolStats): void {
  console.log(
    `  ${label.padEnd(22)} keys=${stats.keys} live=${stats.live} idle=${stats.idle} ` +
      `inUse=${stats.inUse} created=${stats.created} disposed=${stats.disposed} ` +
      `evicted=${stats.evicted} hits=${stats.hits} misses=${stats.misses}`,
  );
}

async function main(): Promise<void> {
  const MAX = 3;

  const pool = new RefCountedLruPool<HttpClient>({
    factory: async (key) => createClient(key),
    dispose: (client) => disposeClient(client),
    max: MAX,
  });
  pool.start();

  // Keys are distinct "services" — different base URLs / API tokens.
  const services = [
    'https://api.payments.internal',
    'https://api.users.internal',
    'https://api.search.internal',
    'https://api.billing.internal',
    'https://api.analytics.internal',
  ];

  console.log('refpool — generic HTTP-client pooling demo');
  console.log(`Pool max = ${MAX} live clients, ${services.length} distinct services.\n`);
  printStats('initial', pool.getStats());

  // --- 1) Refcounting: two concurrent holders of the SAME client ---------
  console.log('\n[1] Refcounting — two concurrent callers share one client:');
  const a = await pool.acquire(services[0]!);
  const b = await pool.acquire(services[0]!);
  a.resource.call('/charge');
  b.resource.call('/refund');
  console.log(
    `  acquired "${services[0]}" twice -> same instance? ${a.resource === b.resource}`,
  );
  printStats('two holders', pool.getStats()); // inUse=1, created=1, hits=1
  a.release();
  printStats('one released', pool.getStats()); // still inUse=1 (b holds it)
  b.release();
  printStats('both released', pool.getStats()); // idle=1, nothing disposed yet

  // --- 2) Bounded `max` + LRU eviction across MANY keys ------------------
  console.log(`\n[2] Bounded max=${MAX} — churn through ${services.length} services:`);
  for (const svc of services) {
    // acquire + release immediately: a typical "borrow for one request" cycle.
    const h = await pool.acquire(svc);
    h.resource.call('/ping');
    h.release();
    const s = pool.getStats();
    console.log(
      `  used ${svc.padEnd(34)} -> live=${s.live} evicted=${s.evicted} disposed=${s.disposed}`,
    );
  }
  console.log(
    `  After touching ${services.length} services, live is capped at ${pool.getStats().live} (= max).`,
  );
  printStats('after churn', pool.getStats());

  // --- 3) LRU recency: re-touch a survivor, then evict the coldest -------
  console.log('\n[3] LRU recency — re-touch the oldest survivor so a colder one is evicted next:');
  const survivors = [...services].slice(-MAX); // last MAX are the live ones
  const oldestSurvivor = survivors[0]!;
  const warm = await pool.acquire(oldestSurvivor);
  warm.release(); // bumps recency so it is NOT the next LRU victim
  const fresh = await pool.acquire('https://api.notifications.internal');
  fresh.release();
  printStats('after new key', pool.getStats());
  console.log(
    `  Re-touched "${oldestSurvivor}" survived; a colder client was evicted & disposed instead.`,
  );

  // --- Drain: dispose everything left -----------------------------------
  console.log('\n[4] Drain — tear down all remaining clients:');
  await pool.drain();
  printStats('after drain', pool.getStats());

  console.log('\nSummary');
  console.log(`  http.Agents created : ${createdAgents}`);
  console.log(`  http.Agents destroyed: ${destroyedAgents}`);
  console.log(
    `  leak check          : ${createdAgents === destroyedAgents ? 'OK — every client disposed' : 'LEAK!'}`,
  );
  console.log(
    `  Touched ${services.length + 1} distinct services but never held more than ${MAX} live clients.`,
  );

  if (createdAgents !== destroyedAgents) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
