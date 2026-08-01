/**
 * Single source of truth for names, routes, and links used across the site.
 *
 * The package name lives here and in `packages/core/package.json` — nowhere else —
 * so renaming the package is a two-line change.
 */

export const packageName = 'just-another-sdk'
export const appName = 'just-another-sdk'
export const tagline = 'The agent loop that cannot hang.'
export const description =
  'A TypeScript agent SDK with zero runtime dependencies. Define an agent, add tools, ' +
  'run the loop, get a typed result.'

export const docsRoute = '/docs'
export const docsContentRoute = '/llms.mdx/docs'

export const gitConfig = {
  user: 'KARDT89',
  repo: 'sylo-sdk',
  branch: 'main',
}

export const links = {
  github: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  npm: `https://www.npmjs.com/package/${packageName}`,
  docs: docsRoute,
  quickstart: `${docsRoute}/quickstart`,
}

export const installCommands = [
  { label: 'pnpm', command: `pnpm add ${packageName}` },
  { label: 'npm', command: `npm i ${packageName}` },
  { label: 'bun', command: `bun add ${packageName}` },
  { label: 'yarn', command: `yarn add ${packageName}` },
] as const
