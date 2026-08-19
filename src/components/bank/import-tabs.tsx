'use client'

import { useTranslations } from 'next-intl'
import { FileJsonIcon, FileTextIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * The two ways questions get into the bank, side by side.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A CLIENT SHELL AROUND SERVER-RENDERED PANELS.                             │
 * │                                                                           │
 * │ Tabs need state, so this component is a client one — but the panels       │
 * │ inside it are passed in as props from the page. That keeps the two        │
 * │ importers' own props (server actions, brand lists, permissions) resolved  │
 * │ on the server, and means switching tabs costs nothing: both panels are    │
 * │ already rendered.                                                         │
 * │                                                                           │
 * │ JSON is the default because it is the route the curated dataset takes and │
 * │ the one somebody arriving at this screen without a paper wants.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function ImportTabs({ json, paper }: { json: React.ReactNode; paper: React.ReactNode }) {
  const t = useTranslations('import')

  return (
    <Tabs defaultValue="json">
      <TabsList>
        <TabsTrigger value="json" className="gap-2">
          <FileJsonIcon aria-hidden />
          {t('tabs.json')}
        </TabsTrigger>
        <TabsTrigger value="paper" className="gap-2">
          <FileTextIcon aria-hidden />
          {t('tabs.paper')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="json" className="pt-6">
        {json}
      </TabsContent>
      <TabsContent value="paper" className="pt-6">
        {paper}
      </TabsContent>
    </Tabs>
  )
}
