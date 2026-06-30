import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/opossum.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['opossum'],
});
