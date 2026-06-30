import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    target: 'es2021',
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
});
