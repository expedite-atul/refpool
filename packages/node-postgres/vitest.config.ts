import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Integration tests spin up a real container; give them room.
    testTimeout: process.env.INTEGRATION === '1' ? 120_000 : 10_000,
    hookTimeout: process.env.INTEGRATION === '1' ? 120_000 : 10_000,
  },
});
