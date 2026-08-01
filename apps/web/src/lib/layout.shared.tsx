import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { TerminalIcon } from 'lucide-react'
import { appName, links } from './shared'

/** Nav configuration shared by the landing page and the docs shell. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-mono font-semibold">
          <TerminalIcon className="size-4 text-term-green" strokeWidth={2} />
          {appName}
        </span>
      ),
    },
    githubUrl: links.github,
    links: [
      { text: 'Docs', url: links.docs, active: 'nested-url' },
      { text: 'npm', url: links.npm, external: true },
    ],
  }
}
