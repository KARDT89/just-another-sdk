import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import prettier from 'eslint-config-prettier'

/**
 * The docs site lints itself with Next's own rules (they cover the App Router,
 * image usage, and hooks) rather than the repo-root config, which is tuned for
 * the published library. The root config ignores `apps/**` so the two never
 * fight over the same files.
 */
export default defineConfig([
  ...nextVitals,
  prettier,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', '.source/**']),
])
