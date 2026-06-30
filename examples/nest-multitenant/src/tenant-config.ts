import type { PoolConfig } from 'pg';

/**
 * Map a tenant id -> node-postgres `PoolConfig`.
 *
 * In a real deployment each tenant typically lives in its own database (or
 * schema). We build the connection string from a template env var so a single
 * `DATABASE_URL_TEMPLATE` drives every tenant. The literal `{tenant}` token is
 * substituted with the (sanitized) tenant id.
 *
 * Example:
 *   DATABASE_URL_TEMPLATE="postgres://app:secret@db.internal:5432/tenant_{tenant}"
 */
export function poolConfigForTenant(tenantId: string): PoolConfig {
  const template =
    process.env.DATABASE_URL_TEMPLATE ??
    'postgres://postgres:postgres@localhost:5432/tenant_{tenant}';

  // Keep tenant ids to a safe charset before splicing into a connection string.
  const safeTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const connectionString = template.includes('{tenant}')
    ? template.replace('{tenant}', safeTenant)
    : template;

  return {
    connectionString,
    // Per-tenant node-postgres pool size (the inner pool that refpool manages).
    max: Number(process.env.PG_POOL_MAX ?? 5),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5_000),
  };
}
