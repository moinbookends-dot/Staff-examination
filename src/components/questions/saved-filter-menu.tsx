'use client'

import { useState, useTransition } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useRouter } from '@/lib/i18n/navigation'
import { filterQueryOf, type SavedFilter } from '@/lib/questions/saved-filters'
import { deleteSavedFilter, saveFilter } from '@/server/actions/saved-filters'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BookmarkIcon, XIcon } from 'lucide-react'

/**
 * A chef's own saved filters.
 *
 * A saved filter is a bookmark: the stored value is the query string, and
 * applying one is a navigation. So this component holds no filter state of its
 * own — it reads the current URL, strips what is not a filter, and hands the
 * result to the server. Everything else on this screen already works that way.
 *
 * These are private (0043). Nothing here says so, because nothing here needs
 * to: the policies are `owner_id = auth.uid()` and the list simply never
 * contains anybody else's.
 */
export function SavedFilterMenu({ filters }: { filters: SavedFilter[] }) {
  const t = useTranslations('questions.saved')
  const params = useSearchParams()
  const router = useRouter()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, startTransition] = useTransition()

  const current = filterQueryOf(params.toString())

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">{t('label')}</span>

      {filters.length === 0 ? (
        <span className="text-sm text-muted-foreground">{t('none')}</span>
      ) : (
        filters.map((filter) => (
          <span key={filter.id} className="inline-flex items-center rounded-md border text-sm">
            <button
              type="button"
              disabled={busy}
              onClick={() => router.push(`/questions?${filter.query}`)}
              className="px-2 py-1 hover:underline disabled:opacity-50"
            >
              {filter.name}
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label={`${t('delete')}: ${filter.name}`}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteSavedFilter({ id: filter.id })
                  if (result.ok) {
                    toast.success(t('deleted'))
                    router.refresh()
                  } else {
                    toast.error(result.error ?? t('delete'))
                  }
                })
              }
              className="border-l px-1.5 py-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              <XIcon className="size-3.5" />
            </button>
          </span>
        ))
      )}

      {naming ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            startTransition(async () => {
              const result = await saveFilter({ name, query: current })
              if (result.ok) {
                toast.success(t('saved'))
                setNaming(false)
                setName('')
                router.refresh()
              } else {
                toast.error(result.error ?? t('save'))
              }
            })
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('placeholder')}
            aria-label={t('namePrompt')}
            autoFocus
            className="h-8 w-40"
            disabled={busy}
          />
          <Button type="submit" size="sm" disabled={busy || name.trim() === ''}>
            {t('save')}
          </Button>
        </form>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            // Saving the unfiltered view produces an entry that does nothing,
            // and the person who made it has no way to tell that from one that
            // stopped working.
            if (current === '') {
              toast.warning(t('nothingToSave'))
              return
            }
            setNaming(true)
          }}
        >
          <BookmarkIcon />
          {t('save')}
        </Button>
      )}
    </div>
  )
}
