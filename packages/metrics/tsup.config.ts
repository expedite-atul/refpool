import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/prometheus.ts', 'src/opentelemetry.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  external: ['prom-client', '@opentelemetry/api', '@refpool/core'],
});
