import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['drizzle-orm', 'drizzle-orm/node-postgres', 'pg', '@refpool/core'],
});
