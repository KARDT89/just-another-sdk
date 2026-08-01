'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton } from '@/components/copy-button'
import { installCommands } from '@/lib/shared'

/** Package-manager tabs for the install command. shadcn `Tabs` + our copy button. */
export function InstallTabs() {
  const first = installCommands[0]

  return (
    <Tabs defaultValue={first.label} className="w-full max-w-md gap-0">
      <TabsList className="h-9 rounded-b-none border border-b-0 bg-muted/40 font-mono text-xs">
        {installCommands.map(({ label }) => (
          <TabsTrigger key={label} value={label} className="text-xs">
            {label}
          </TabsTrigger>
        ))}
      </TabsList>

      {installCommands.map(({ label, command }) => (
        <TabsContent key={label} value={label} className="mt-0">
          <div className="flex items-center gap-2 rounded-md rounded-tl-none border bg-card px-3 py-2">
            <code className="flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap">
              <span className="mr-2 select-none text-term-green">$</span>
              {command}
            </code>
            <CopyButton value={command} />
          </div>
        </TabsContent>
      ))}
    </Tabs>
  )
}
