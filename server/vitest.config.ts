import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/test-pipeline.ts'],
    testTimeout: 120_000, // pipeline tests can be slow (DB + Absurd)
    hookTimeout: 30_000,
  },
});
