/**
 * Single source of truth for names, routes, and links used across the site.
 *
 * The package name lives here and in `packages/core/package.json` — nowhere else —
 * so renaming the package is a two-line change.
 */

import corePackage from '../../../../packages/core/package.json'

export const packageName = 'just-another-sdk'
export const appName = 'just-another-sdk'

/**
 * Read from the package rather than typed here.
 *
 * The hero badge said `v0.1.0` for two releases because it was a string in JSX.
 * Importing it means the site cannot claim a version the package does not have.
 */
export const version: string = corePackage.version
// Matches the hero heading. A <title> that disagrees with the H1 reads as a
// page nobody has looked at in a while.
export const tagline = 'Ship the agent. Keep the pager quiet.'
export const description =
  'A TypeScript agent SDK with zero runtime dependencies. Native Claude, Gemini, and OpenAI, ' +
  'a loop that cannot hang, and dangerous things refused by default.'

/** Where the docs are actually hosted. Feeds `metadataBase`, OG, and Twitter. */
export const siteUrl = 'https://sdk.tamalsarkar.dev'

export const docsRoute = '/docs'
export const docsContentRoute = '/llms.mdx/docs'

export const gitConfig = {
  user: 'KARDT89',
  repo: 'just-another-sdk',
  branch: 'main',
}

export const links = {
  github: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  npm: `https://www.npmjs.com/package/${packageName}`,
  docs: docsRoute,
  quickstart: `${docsRoute}/quickstart`,
}

/**
 * Where the `.mdx` files live on GitHub, used by each page's "edit this page"
 * link. The `apps/web/` prefix matters: this is a monorepo, so the content is not
 * at the repository root the way a standalone Fumadocs app would have it.
 */
export const docsSourceUrl =
  `https://github.com/${gitConfig.user}/${gitConfig.repo}` +
  `/blob/${gitConfig.branch}/apps/web/content/docs`

export const installCommands = [
  { label: 'pnpm', command: `pnpm add ${packageName}` },
  { label: 'npm', command: `npm i ${packageName}` },
  { label: 'bun', command: `bun add ${packageName}` },
  { label: 'yarn', command: `yarn add ${packageName}` },
] as const
