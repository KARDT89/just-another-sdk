import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'providers/index': 'src/providers/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  target: 'node20.19',
  platform: 'neutral',
  // The whole point of this package: nothing gets bundled in, because there is
  // nothing to bundle. `zod` is an optional peer reached by dynamic import for
  // JSON Schema conversion — it must stay external so consumers who do not use
  // it never pay for it.
  external: [/^node:/, 'zod'],
  publint: true,
  unused: false,
})
