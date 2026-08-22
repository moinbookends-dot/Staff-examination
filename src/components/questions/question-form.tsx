'use client'

import { useMemo, useState, useTransition } from 'react'
// Locale-aware router: router.push('/questions/…') must keep the /hi prefix, or
// a chef working in Hindi is silently dropped back to English on every save.
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { nextStatuses, type QuestionStatusValue } from '@/lib/questions/status'
import { BLOOM_LEVELS, type BloomLevel } from '@/lib/questions/metadata'
import { toast } from 'sonner'
import {
  QUESTION_TYPES,
  TYPE_FORMATS,
  type AnswerKey,
  type AnswerPayload,
  type QuestionContentDraft,
  type QuestionType,
  type ResponseFormat,
} from '@/lib/questions/schemas'
import { getFormat } from '@/lib/questions/registry'
import { publishIssues } from '@/lib/questions/publish'
import {
  saveQuestion,
  publishQuestion,
  setQuestionStatus,
  deleteQuestion,
  createTag,
  type CategoryOption,
  type QuestionDetail,
  type QuestionRevisionEntry,
  type TagOption,
} from '@/server/actions/questions'
import { FormatEditor, FormatRenderer } from './registry'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PlusIcon } from 'lucide-react'

/**
 * The question editor — one component for both "new" and "edit".
 *
 * SAVE IS EXPLICIT, NOT AUTOSAVE. Once a question is live, every substantive
 * save bumps `revision` (migration 0011) and writes a history row (0012). An
 * autosave on a debounce would mint a revision every time a chef paused typing,
 * fragmenting the per-question difficulty statistics that the revision counter
 * exists to keep honest — and filling the history view with thirty entries
 * describing one edit.
 *
 * CONTENT AND KEY ARE HELD TOGETHER in one state object and handed to the
 * format editor as a pair. See the note on FormatEditorProps.onChange.
 */

interface Props {
  question: QuestionDetail | null
  categories: CategoryOption[]
  tags: TagOption[]
  revisions: QuestionRevisionEntry[]
  canRetire: boolean
}

interface Payload {
  content: QuestionContentDraft
  answerKey: AnswerKey
}

export function QuestionForm({ question, categories, tags, revisions, canRetire }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const tTypes = useTranslations('questions.types')
  const tFormats = useTranslations('questions.formats')
  const tStatusAction = useTranslations('questions.statusAction')
  const tBloom = useTranslations('questions.bloom')
  const tSource = useTranslations('questions.source')
  const tMeta = useTranslations('questions')

  const [type, setType] = useState<QuestionType>(question?.type ?? 'mcq_single')
  const [format, setFormat] = useState<ResponseFormat>(question?.response_format ?? 'choice_single')
  const [stem, setStem] = useState(question?.stem ?? '')

  const [payload, setPayload] = useState<Payload>(() => {
    const definition = getFormat(question?.response_format ?? 'choice_single')
    return {
      content: (question?.content as QuestionContentDraft) ?? definition.emptyContent(),
      answerKey: (question?.answerKey as AnswerKey) ?? definition.emptyKey(),
    }
  })

  const [categoryId, setCategoryId] = useState(question?.category_id ?? '')
  const [difficulty, setDifficulty] = useState(question?.difficulty ?? 3)
  const [marks, setMarks] = useState(question?.marks ?? 1)
  const [negativeMarks, setNegativeMarks] = useState(question?.negative_marks ?? 0)
  const [estimatedSeconds, setEstimatedSeconds] = useState<string>(
    question?.estimated_seconds ? String(question.estimated_seconds) : '',
  )
  const [explanation, setExplanation] = useState(question?.explanation ?? '')
  const [referenceNote, setReferenceNote] = useState(question?.reference_note ?? '')
  const [tagIds, setTagIds] = useState<string[]>(question?.tagIds ?? [])
  const [availableTags, setAvailableTags] = useState(tags)
  const [newTag, setNewTag] = useState('')
  const [changeNote, setChangeNote] = useState('')
  const [bloomLevel, setBloomLevel] = useState<BloomLevel | null>(question?.bloom_level ?? null)

  const [previewAnswer, setPreviewAnswer] = useState<AnswerPayload>(() =>
    getFormat(question?.response_format ?? 'choice_single').emptyAnswer(),
  )
  const [pendingFormat, setPendingFormat] = useState<ResponseFormat | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The same function the server runs before it flips the status. Computed on
  // every render so the Publish button and its reason list can never disagree
  // with what the action will decide.
  const issues = useMemo(
    () => publishIssues(payload.content, payload.answerKey),
    [payload],
  )
  const allowedFormats = TYPE_FORMATS[type]
  const isNew = question === null

  /** Untouched means we can switch format without asking. */
  function isPristine(): boolean {
    const empty = getFormat(format).emptyContent()
    return JSON.stringify(payload.content) === JSON.stringify(empty)
  }

  function applyFormat(next: ResponseFormat) {
    const definition = getFormat(next)
    setFormat(next)
    setPayload({ content: definition.emptyContent(), answerKey: definition.emptyKey() })
    setPreviewAnswer(definition.emptyAnswer())
  }

  function requestFormat(next: ResponseFormat) {
    if (next === format) return
    if (isPristine()) applyFormat(next)
    else setPendingFormat(next)
  }

  function onTypeChange(next: QuestionType) {
    setType(next)
    // A type constrains its formats (TYPE_FORMATS mirrors the q_format_matches_type
    // CHECK). Switching from Essay to True/False must move the format too, or
    // the insert fails on a constraint the chef never saw.
    if (!TYPE_FORMATS[next].includes(format)) {
      applyFormat(TYPE_FORMATS[next][0])
    }
  }

  function save(then?: (id: string) => void) {
    setError(null)
    startTransition(async () => {
      const result = await saveQuestion({
        id: question?.id ?? null,
        type,
        responseFormat: format,
        stem,
        content: payload.content,
        answerKey: payload.answerKey,
        brandId: question?.brand_id ?? null,
        categoryId: categoryId || null,
        difficulty,
        marks,
        negativeMarks,
        estimatedSeconds: estimatedSeconds ? Number(estimatedSeconds) : null,
        explanation: explanation || null,
        referenceNote: referenceNote || null,
        tagIds,
        changeNote: changeNote || null,
        bloomLevel,
      })

      if (!result.ok || !result.id) {
        setError(result.error ?? 'Could not save.')
        return
      }

      setChangeNote('')
      toast.success(isNew ? 'Question created.' : 'Saved.')

      if (then) then(result.id)
      else if (isNew) router.push(`/questions/${result.id}`)
      else router.refresh()
    })
  }

  function publish() {
    // Save first, always. Publishing validates what is STORED, so publishing
    // without saving would validate the previous version and activate text the
    // chef is no longer looking at.
    save((id) => {
      startTransition(async () => {
        const result = await publishQuestion(id)
        if (!result.ok) {
          setError(result.error ?? 'Could not publish.')
          return
        }
        toast.success('Published.')
        if (isNew) router.push(`/questions/${id}`)
        else router.refresh()
      })
    })
  }

  function changeStatus(status: QuestionStatusValue) {
    startTransition(async () => {
      const result = await setQuestionStatus({ id: question!.id, status })
      if (!result.ok) setError(result.error ?? 'Could not change the status.')
      else router.refresh()
    })
  }

  function addTag() {
    const name = newTag.trim()
    if (!name) return
    startTransition(async () => {
      const result = await createTag({ name })
      if (!result.ok || !result.tag) {
        setError(result.error ?? 'Could not create the tag.')
        return
      }
      setAvailableTags((current) => [...current, result.tag!].sort((a, b) => a.name.localeCompare(b.name)))
      setTagIds((current) => [...current, result.tag!.id])
      setNewTag('')
    })
  }

  const canSave = stem.trim().length >= 3 && !pending

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isNew ? 'New question' : 'Edit question'}
          </h1>
          {question && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant={question.status === 'active' ? 'default' : 'secondary'}>
                {question.status}
              </Badge>
              <span>revision {question.revision}</span>
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => save()} disabled={!canSave}>
            Save
          </Button>
          <Button
            onClick={publish}
            // Disabled, with the reasons listed below rather than behind a
            // failed submit. A button that is enabled and then refuses teaches
            // people to click it twice.
            disabled={!canSave || issues.length > 0 || question?.status === 'active'}
            title={issues.length > 0 ? 'Fix the issues listed below first' : undefined}
          >
            {question?.status === 'active' ? 'Published' : 'Publish'}
          </Button>
          {question && canRetire && (
            <>
              {/* Offered from the lifecycle rather than hard-coded.
                  This used to be a fixed pair — Retire, or Return to draft if
                  already retired — which was right for a three-status world and
                  wrong the moment 0037 added four more: `review` and `approved`
                  were unreachable from anywhere in the product, and a button
                  offering a move the 0040 trigger refuses would fail at the
                  database with a message nobody should have to read.
                  `active` is excluded because Publish above owns it: going
                  active runs the validation gate, and a plain status update
                  would skip it. */}
              {nextStatuses(question.status as QuestionStatusValue)
                .filter((status) => status !== 'active')
                .map((status) => (
                  <Button
                    key={status}
                    variant="outline"
                    onClick={() => changeStatus(status)}
                    disabled={pending}
                  >
                    {tStatusAction(status)}
                  </Button>
                ))}
              <Button variant="destructive" onClick={() => setConfirmDelete(true)} disabled={pending}>
                Remove
              </Button>
            </>
          )}
        </div>
      </div>

      {error && <InlineError>{error}</InlineError>}

      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        {/* ── Metadata ───────────────────────────────────────────────────── */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="q-type">Question type</Label>
              <select
                id="q-type"
                value={type}
                onChange={(e) => onTypeChange(e.target.value as QuestionType)}
                disabled={pending}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {QUESTION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {tTypes(value)}
                  </option>
                ))}
              </select>
            </div>

            {/* Only shown when the type actually offers a choice — the four
                media types do; the other ten are fixed to one format, and a
                one-option dropdown is noise. */}
            {allowedFormats.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="q-format">Answer format</Label>
                <select
                  id="q-format"
                  value={format}
                  onChange={(e) => requestFormat(e.target.value as ResponseFormat)}
                  disabled={pending}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                >
                  {allowedFormats.map((value) => (
                    <option key={value} value={value}>
                      {tFormats(getFormat(value).labelKey)}
                    </option>
                  ))}
                </select>
                <p className="text-sm text-muted-foreground">
                  {tFormats(getFormat(format).descriptionKey)}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="q-category">Category</Label>
              <select
                id="q-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                disabled={pending}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              >
                <option value="">Uncategorised</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.parent_id ? '— ' : ''}
                    {category.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="q-difficulty">Difficulty</Label>
                <select
                  id="q-difficulty"
                  value={difficulty}
                  onChange={(e) => setDifficulty(Number(e.target.value))}
                  disabled={pending}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                >
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="q-seconds">Time (s)</Label>
                <Input
                  id="q-seconds"
                  type="number"
                  min={5}
                  max={3600}
                  value={estimatedSeconds}
                  onChange={(e) => setEstimatedSeconds(e.target.value)}
                  placeholder="60"
                  disabled={pending}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="q-marks">Marks</Label>
                <Input
                  id="q-marks"
                  type="number"
                  min={0.5}
                  step="0.5"
                  value={marks}
                  onChange={(e) => setMarks(Number(e.target.value) || 1)}
                  disabled={pending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="q-negative">Negative</Label>
                <Input
                  id="q-negative"
                  type="number"
                  min={0}
                  step="0.5"
                  value={negativeMarks}
                  onChange={(e) => setNegativeMarks(Number(e.target.value) || 0)}
                  disabled={pending}
                />
              </div>
            </div>

            {/* ── Bloom level ──────────────────────────────────────────────
                Editable, unlike the provenance below it: what a question asks
                the candidate to DO is an authoring decision, and M9's blueprint
                validation reads it. A native <select> to match the rest of this
                form and the filter bar. */}
            <div className="space-y-2">
              <Label htmlFor="q-bloom">{tMeta('bloomLabel')}</Label>
              <select
                id="q-bloom"
                value={bloomLevel ?? ''}
                onChange={(e) =>
                  setBloomLevel((e.target.value || null) as BloomLevel | null)
                }
                disabled={pending}
                className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">{tMeta('bloomNone')}</option>
                {BLOOM_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {tBloom(level)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{tMeta('bloomHint')}</p>
            </div>

            {/* ── Provenance, read-only ────────────────────────────────────
                Shown, never editable. `source` and `imported_from` record where
                a question CAME FROM; a chef rewording an imported question has
                not made it hand-written. saveQuestion sends neither field, so
                0039's coalesce preserves them — the guarantee is structural
                rather than a rule anyone has to remember. */}
            {question && (
              <div className="space-y-2">
                {/* Not a <Label>: there is no form control to label. A label
                    pointing at nothing is announced as an orphan. */}
                <p className="text-sm font-medium">{tMeta('provenance')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{tSource(question.source)}</Badge>
                  {question.imported_from && (
                    <Badge variant="outline">
                      {tMeta('importedFrom', { source: question.imported_from })}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{tMeta('provenanceHint')}</p>
              </div>
            )}

            <div className="space-y-2">
              <Label>Tags</Label>
              <div className="space-y-1.5">
                {availableTags.map((tag) => (
                  <label key={tag.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={tagIds.includes(tag.id)}
                      onCheckedChange={(checked) =>
                        setTagIds((current) =>
                          checked ? [...current, tag.id] : current.filter((id) => id !== tag.id),
                        )
                      }
                      disabled={pending}
                    />
                    {tag.name}
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  placeholder="New tag"
                  disabled={pending}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addTag()
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={addTag}
                  disabled={pending || newTag.trim().length < 2}
                  aria-label="Add tag"
                >
                  <PlusIcon />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Content ────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="q-stem">Question</Label>
            <Textarea
              id="q-stem"
              value={stem}
              onChange={(e) => setStem(e.target.value)}
              placeholder="What is the minimum safe internal temperature for chicken?"
              rows={3}
              disabled={pending}
            />
          </div>

          <Tabs defaultValue="edit">
            <TabsList>
              <TabsTrigger value="edit">Answer</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
              {!isNew && <TabsTrigger value="history">History</TabsTrigger>}
            </TabsList>

            <TabsContent value="edit" className="space-y-4 pt-4">
              <FormatEditor
                format={format}
                content={payload.content}
                answerKey={payload.answerKey}
                onChange={setPayload}
                disabled={pending}
                issues={issues}
              />

              <div className="space-y-2">
                <Label htmlFor="q-explanation">Explanation</Label>
                <Textarea
                  id="q-explanation"
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  placeholder="Shown after the exam, if the exam is configured to reveal answers."
                  rows={2}
                  disabled={pending}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="q-reference">Reference</Label>
                <Input
                  id="q-reference"
                  value={referenceNote}
                  onChange={(e) => setReferenceNote(e.target.value)}
                  placeholder="SOP 4.2, or a cookbook page"
                  disabled={pending}
                />
              </div>

              {/* The note reaches question_revisions via save_question's GUC.
                  Offered only once a question is live: annotating drafts nobody
                  has answered is friction for no benefit. */}
              {question && question.status !== 'draft' && (
                <div className="space-y-2">
                  <Label htmlFor="q-change-note">What changed?</Label>
                  <Input
                    id="q-change-note"
                    value={changeNote}
                    onChange={(e) => setChangeNote(e.target.value)}
                    placeholder="Clarified the temperature"
                    disabled={pending}
                  />
                  <p className="text-sm text-muted-foreground">
                    Stored against this revision so nobody has to read a diff later.
                  </p>
                </div>
              )}

              {issues.length > 0 && (
                <div className="rounded-md border border-dashed p-3">
                  <p className="text-sm font-medium">Before this can be published</p>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {issues.map((issue, index) => (
                      <li key={`${issue.path}-${index}`}>
                        <span className="font-mono text-xs">{issue.path}</span> — {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </TabsContent>

            <TabsContent value="preview" className="pt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-normal">
                    {stem || <span className="text-muted-foreground">No question text yet.</span>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {/* Interactive, not a screenshot: the fastest way to notice
                      that two options say the same thing is to try to answer
                      it. Nothing is submitted or graded. */}
                  <FormatRenderer
                    format={format}
                    content={payload.content}
                    answer={previewAnswer}
                    onAnswerChange={setPreviewAnswer}
                  />
                </CardContent>
              </Card>
              <p className="pt-2 text-sm text-muted-foreground">
                This is what a candidate sees. The answer key is never sent to their browser.
              </p>
            </TabsContent>

            {!isNew && (
              <TabsContent value="history" className="pt-4">
                {revisions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No history yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {revisions.map((entry) => (
                      <li key={entry.revision} className="rounded-md border p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">Revision {entry.revision}</span>
                          <span className="text-muted-foreground">
                            {new Date(entry.edited_at).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-muted-foreground">
                          {entry.editor_name ?? 'Unknown'}
                          {entry.change_note ? ` — ${entry.change_note}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="pt-2 text-sm text-muted-foreground">
                  Revisions are stamped when the wording, content, format or marks change, so
                  analytics never merge two different questions into one statistic.
                </p>
              </TabsContent>
            )}
          </Tabs>
        </div>
      </div>

      {/* Changing the format cannot preserve the answer — a set of choices is
          not a sequence — so it is a discard, and says so. */}
      <AlertDialog open={pendingFormat !== null} onOpenChange={(open) => !open && setPendingFormat(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change the answer format?</AlertDialogTitle>
            <AlertDialogDescription>
              The options and answer key you have written will be cleared. The question text,
              category and marks are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingFormat) applyFormat(pendingFormat)
                setPendingFormat(null)
              }}
            >
              Change format
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this question?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from the bank but is not destroyed — past exam results that cite it
              stay explainable. Retire it instead if you only want it out of circulation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteQuestion(question!.id)
                  if (!result.ok) setError(result.error ?? 'Could not remove it.')
                  else router.push('/questions')
                })
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
