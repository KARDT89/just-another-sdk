import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every test in this package must run offline against the mock provider.
    // If a test reaches the network, that is a bug in the test.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/testing/**'],
      reporter: ['text', 'lcov'],
    },
  },
})
