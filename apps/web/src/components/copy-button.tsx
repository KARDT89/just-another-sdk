'use client'

import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

/** Copy-to-clipboard, with the confirmation state a developer expects. */
export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        })
      }}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-md border',
        'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        className,
      )}
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-term-green" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  )
}
