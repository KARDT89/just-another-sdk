import { RootProvider } from 'fumadocs-ui/provider/next'
import { Geist, Geist_Mono } from 'next/font/google'
import type { Metadata, Viewport } from 'next'
import './global.css'
import { cn } from '@/lib/utils'
import { appName, description, links, tagline } from '@/lib/shared'

/**
 * Geist Mono is loaded as a first-class family, not just for code blocks: the
 * site's whole visual language is terminal-derived, so monospace carries the
 * headings and UI chrome too.
 */
const sans = Geist({ subsets: ['latin'], variable: '--font-sans' })
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: {
    default: `${appName} — ${tagline}`,
    template: `%s — ${appName}`,
  },
  description,
  keywords: ['ai agent', 'llm', 'typescript', 'sdk', 'tool calling', 'openrouter', 'agents'],
  metadataBase: new URL('https://just-another-sdk.vercel.app'),
  openGraph: {
    title: `${appName} — ${tagline}`,
    description,
    type: 'website',
    siteName: appName,
  },
  twitter: { card: 'summary_large_image', title: appName, description },
  alternates: { canonical: '/' },
  other: { 'npm:package': links.npm },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
  ],
}

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={cn(sans.variable, mono.variable)} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans antialiased">
        {/* Dark by default — the terminal aesthetic assumes it — but the theme
            toggle still works, so the docs respect a reader's preference. */}
        <RootProvider theme={{ defaultTheme: 'dark' }}>{children}</RootProvider>
      </body>
    </html>
  )
}
