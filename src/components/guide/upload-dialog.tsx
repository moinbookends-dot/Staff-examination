'use client'

import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2, InfoIcon, UploadIcon } from 'lucide-react'
import { useRouter } from '@/lib/i18n/navigation'
import { createUploadTicket, finaliseUpload } from '@/server/actions/upload-document'
import type { FinaliseUploadResult, UploadFailure } from '@/server/actions/upload-document'
import { env } from '@/lib/env'
import { sha256File } from '@/lib/crypto/sha256'
import {
  ACCEPTED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  SOURCE_DOCUMENT_KINDS,
  mimeTypeAgrees,
  sniffMimeType,
  type SourceDocumentKind,
} from '@/lib/imports/source-documents'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { InlineError } from '@/components/ui/inline-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * The upload form for Guide (AI) — and the only place the file itself is ever
 * held.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THREE CALLS, AND THE BYTES DO NOT GO THROUGH THE APPLICATION SERVER.      ║
 * ║                                                                           ║
 * ║   1. createUploadTicket({...metadata, filename, byteSize, mime, sha256})  ║
 * ║      → the row is reserved and a signed URL comes back for one exact      ║
 * ║        path, or the answer is "you already have this file".               ║
 * ║   2. PUT the File at that URL → straight at Storage, with progress.       ║
 * ║   3. finaliseUpload(documentId) → the server confirms the object arrived  ║
 * ║      and queues it for reading.                                           ║
 * ║                                                                           ║
 * ║ This is what removed the 1 MB ceiling. A Server Action's request body is  ║
 * ║ capped at 1 MB by default in Next 16 and next.config.ts does not raise    ║
 * ║ it, so the old single POST of a FormData containing the File was rejected ║
 * ║ by the framework before any code in this repo ran. Both action calls      ║
 * ║ below carry a few hundred bytes of JSON, so that default stops mattering  ║
 * ║ rather than being argued with.                                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ XMLHttpRequest, IN 2026, ON PURPOSE — AND IT IS THE ONLY OPTION.          ║
 * ║                                                                           ║
 * ║ fetch() cannot report upload progress. There is no event, no callback and ║
 * ║ no readable side of the request body; the only shipped way to watch bytes ║
 * ║ leave a browser is xhr.upload's progress events. A request-body           ║
 * ║ ReadableStream with `duplex: 'half'` would let us count them ourselves,   ║
 * ║ but it is Chromium-only and HTTP/2-only, so on Safari — which is every    ║
 * ║ iPhone in every kitchen this product is for — it silently does not work.  ║
 * ║                                                                           ║
 * ║ That is also why storage-js's uploadToSignedUrl() is not used here. It is ║
 * ║ one await of fetch() with nothing to observe, and a 92 MB cookbook on a   ║
 * ║ kitchen's connection is several minutes of a dialog that says only        ║
 * ║ "Uploading…". A progress bar that cannot move is indistinguishable from a ║
 * ║ crash, and the person's next move is to close the tab — which is exactly  ║
 * ║ the thing that strands the row this flow reserved.                        ║
 * ║                                                                           ║
 * ║ WHAT THAT COSTS: the request below is hand-built, so the headers          ║
 * ║ uploadToSignedUrl would have sent are spelled out in putSignedUpload().   ║
 * ║ They are copied from storage-js 2.110.8 and the reason for each one is    ║
 * ║ written beside it. If that package changes what a signed upload needs,    ║
 * ║ nothing here will fail to compile.                                        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE CHECKS IN THIS FILE ARE A COURTESY. THEY ARE NOT A CONTROL — AND      │
 * │ THAT MATTERS MORE THAN IT USED TO.                                        │
 * │                                                                           │
 * │ Size, emptiness, the declared type and now the MAGIC NUMBER are all       │
 * │ checked here. The server re-checks the first three against the same       │
 * │ constants, but it re-checks them against NUMBERS AND STRINGS THIS FILE    │
 * │ SENDS, because it never receives the file. It cannot re-check the fourth  │
 * │ at all.                                                                   │
 * │                                                                           │
 * │ So the sniff moved here, where the bytes are, and it is honestly a        │
 * │ courtesy: anyone who opens a console can skip it. It still earns its      │
 * │ place — a .docx renamed to .pdf is an ordinary mistake, and catching it   │
 * │ now costs eight bytes read locally instead of failing at page one of an   │
 * │ OCR run that starts tens of minutes after the person walked away.         │
 * │                                                                           │
 * │ What remains BINDING is on the server: the permission, the allowlist      │
 * │ against the declared type, and every policy in 0048 — including the       │
 * │ storage INSERT policy, which is evaluated when the ticket is signed.      │
 * │                                                                           │
 * │ The same goes for the sha256 this file computes. See the box in           │
 * │ src/server/actions/upload-document.ts: it makes dedupe work and it        │
 * │ proves nothing about content.                                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** The `accept` attribute, read off the allowlist so the two cannot drift. */
const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(',')

const MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))

/** A refusal about the CHOSEN FILE, as a message key. Blocks submit until the
 *  file changes, which is why "the upload failed" does not belong in here. */
type Problem = 'empty' | 'tooLarge' | 'unsupported' | 'mismatch' | 'chooseFile' | 'unreadable'

/** Which leg of the sequence is running. Null whenever nothing is. */
type Phase = 'checking' | 'sending' | 'finishing'

/**
 * What a stopped upload left behind.
 *
 * 'clean' — stopped before a ticket existed, so there is nothing to explain.
 * 'reserved' — stopped after the row was reserved; finaliseUpload has been told
 * and has tombstoned it, and that tombstone is worth warning about because it
 * keeps the (company_id, sha256) slot.
 */
type Stopped = 'clean' | 'reserved'

/**
 * Whatever is wrong with the chosen file, as a message key — not as a sentence.
 *
 * Returning a key rather than English keeps every string this component can
 * produce inside the message bundle, which is what makes the refusals readable
 * in Hindi and Gujarati. The server's own refusals are the exception and are
 * rendered verbatim; the box beside `outcome` in the JSX says why.
 */
function fileProblem(file: File): Problem | null {
  // Before the size: `check (byte_size > 0)` makes an empty file a 23514 on the
  // server, and "that file is empty" is the sentence a person can act on.
  if (file.size === 0) return 'empty'
  if (file.size > MAX_UPLOAD_BYTES) return 'tooLarge'
  // `as readonly string[]` because file.type is a plain string and ACCEPTED_
  // MIME_TYPES is a tuple of literals — .includes() will not compare them
  // otherwise. Same widening the action does, for the same reason.
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) return 'unsupported'
  return null
}

/**
 * Do the file's first bytes agree with what it says it is?
 *
 * Eight bytes, because PNG's signature is the longest of the four
 * sniffMimeType knows and it reads a fixed prefix — slicing is the caller's
 * job and File.slice() reads only that much, so this is cheap on a 92 MB scan.
 *
 * CSV passes: mimeTypeAgrees now answers "no magic number exists for this
 * format" separately from "the magic number disagrees", which is what makes
 * running the sniff here possible at all. Before that fix this function would
 * have refused every CSV ever written.
 */
async function bytesDisagree(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  return !mimeTypeAgrees(file.type, sniffMimeType(head))
}

/** What the direct transfer did. Not a thrown error: stopping is ordinary. */
type TransferResult =
  | { ok: true }
  | { ok: false; reason: 'aborted' }
  | { ok: false; reason: 'failed'; status: number | null }

/**
 * PUT the file at the signed URL, reporting progress and obeying an abort.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE HEADERS ARE storage-js 2.110.8's, MINUS THE SESSION BEARER.           │
 * │                                                                           │
 * │ uploadToSignedUrl() sends a Blob as multipart/form-data, which means the  │
 * │ object's content type comes from the Blob rather than from the            │
 * │ `contentType` option — that option is silently ignored on that path. A    │
 * │ raw body with an explicit `content-type` is the branch storage-js uses    │
 * │ for streams, it is what storage-api reads to set the object's mime type,  │
 * │ and it is the one that cannot disagree with the mime_type the ticket      │
 * │ already wrote into the row.                                               │
 * │                                                                           │
 * │ No `authorization`. The token in the query string IS the authorisation —  │
 * │ storage-js documents this endpoint as needing no `objects` policy at all, │
 * │ because the policy was evaluated when the ticket was signed on the        │
 * │ caller's own client. `apikey` is sent because storage-js sends it on this │
 * │ exact request, which is what makes it a header the bucket's CORS is       │
 * │ already known to allow.                                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function putSignedUpload(
  signedUrl: string,
  file: File,
  options: { signal: AbortSignal; onProgress: (fraction: number | null) => void },
): Promise<TransferResult> {
  const { signal, onProgress } = options

  return new Promise<TransferResult>((resolve) => {
    if (signal.aborted) {
      resolve({ ok: false, reason: 'aborted' })
      return
    }

    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const settle = (result: TransferResult) => {
      signal.removeEventListener('abort', abort)
      resolve(result)
    }

    xhr.open('PUT', signedUrl, true)
    xhr.setRequestHeader('apikey', env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
    // file.type and not a fallback: an empty type never reaches here, because
    // fileProblem refuses anything that is not on the allowlist and '' is not.
    xhr.setRequestHeader('content-type', file.type)
    // storage-js's DEFAULT_FILE_OPTIONS.cacheControl, so an object uploaded
    // this way is cached exactly as one uploaded through the client would be.
    xhr.setRequestHeader('cache-control', 'max-age=3600')
    // Upsert is decided at SIGN time and the ticket did not ask for it. Sent
    // anyway, and false, so this request cannot be the one that starts
    // overwriting an ingested document.
    xhr.setRequestHeader('x-upsert', 'false')

    // No xhr.timeout. The default is "no timeout", which is the right answer
    // for 92 MB on a kitchen's connection; a number here would be a guess that
    // kills slow uploads that were working.
    xhr.upload.onprogress = (event) => {
      // lengthComputable is false on some proxies and for chunked encodings.
      // Reporting null rather than a made-up figure is what lets the bar go
      // indeterminate instead of lying.
      onProgress(event.lengthComputable && event.total > 0 ? event.loaded / event.total : null)
    }

    xhr.onload = () =>
      settle(
        xhr.status >= 200 && xhr.status < 300
          ? { ok: true }
          : { ok: false, reason: 'failed', status: xhr.status },
      )
    xhr.onerror = () => settle({ ok: false, reason: 'failed', status: null })
    xhr.ontimeout = () => settle({ ok: false, reason: 'failed', status: null })
    xhr.onabort = () => settle({ ok: false, reason: 'aborted' })

    signal.addEventListener('abort', abort, { once: true })
    xhr.send(file)
  })
}

/**
 * The upload button and the dialog behind it.
 *
 * Open state lives here; every field lives in <UploadForm>, which Base UI
 * unmounts with the popup. That is the whole reset story: closing a
 * half-filled form and reopening it gives a clean one without a single line of
 * clearing code that could forget a field.
 *
 * `busy` also lives here, and only because closing has to be refused while
 * bytes are moving — see onOpenChange.
 */
export function UploadDialog() {
  const t = useTranslations('guide.upload')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    // modal defaults to true, which is what traps focus, locks page scroll and
    // makes Escape close — Base UI does all of it, and a hand-rolled trap here
    // would be a worse copy of the one already in the dependency.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        /*
         * A CLOSE REQUEST DURING AN UPLOAD IS REFUSED, NOT OBEYED.
         *
         * Escape, the backdrop and the corner X would otherwise unmount the
         * form mid-transfer. The XHR would carry on with nobody left to call
         * finaliseUpload, so the reserved row would sit at 'uploaded' forever
         * and — dedupe running first — answer the next attempt at the same
         * file with "you already have this". Refusing costs nothing, because
         * the footer offers an explicit Stop that aborts the transfer AND
         * cleans the row up.
         *
         * Refusing works because `open` is controlled: declining to change the
         * state re-renders the dialog open.
         */
        if (!next && busy) return
        setOpen(next)
      }}
      // Stops the click-outside from even being attempted while busy, so the
      // popup does not flicker against a refusal it was always going to get.
      disablePointerDismissal={busy}
    >
      {/* render={} and not asChild: this is Base UI, not Radix. */}
      <DialogTrigger render={<Button />}>
        <UploadIcon />
        {t('trigger')}
      </DialogTrigger>

      {/* The default popup is sm:max-w-sm, which is too narrow for four fields
          and a description. The corner X is hidden rather than left to be
          pressed and ignored. */}
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <UploadForm onUploaded={() => setOpen(false)} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  )
}

function UploadForm({
  onUploaded,
  onBusyChange,
}: {
  onUploaded: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const t = useTranslations('guide.upload')
  const tKinds = useTranslations('guide.kinds')
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [file, setFile] = useState<File | null>(null)
  const [kind, setKind] = useState<SourceDocumentKind | ''>('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  const [problem, setProblem] = useState<Problem | null>(null)
  /** The last answer either action gave, `ok` excepted — that one closes the dialog. */
  const [outcome, setOutcome] = useState<UploadFailure | null>(null)
  /** A failure this component established itself, as a message key. Separate
   *  from `problem` because it must NOT disable the button that retries it. */
  const [clientFailure, setClientFailure] = useState<'notStored' | null>(null)
  const [stopped, setStopped] = useState<Stopped | null>(null)

  const [phase, setPhase] = useState<Phase | null>(null)
  /** 0–1, or null for "running, but the total is not knowable". */
  const [fraction, setFraction] = useState<number | null>(null)

  /** Aborts the hash loop and the transfer. Replaced per submit, cleared in the
   *  same finally that clears the phase. */
  const abortRef = useRef<AbortController | null>(null)

  const busy = phase !== null || pending

  // The dialog needs this to refuse a close. An effect rather than a call
  // inside submit(), so it cannot drift from the state it reports.
  useEffect(() => {
    onBusyChange(busy)
  }, [busy, onBusyChange])

  // The dialog refuses to close while busy, so this should never fire with an
  // upload in flight. It is here for the paths that do not go through
  // onOpenChange at all — a route change, a hot reload — where a detached XHR
  // pushing 92 MB at a bucket for a form nobody can see is the worse outcome.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // useId, not hand-written ids: the dialog is a component and nothing stops a
  // second one existing on the page. Duplicate ids would silently point every
  // <label> and aria-describedby at the first copy's controls.
  const uid = useId()
  const fileId = `${uid}-file`
  const kindId = `${uid}-kind`
  const titleId = `${uid}-title`
  const descriptionId = `${uid}-description`
  const fileHintId = `${uid}-file-hint`
  const fileErrorId = `${uid}-file-error`
  const kindHintId = `${uid}-kind-hint`
  const statusId = `${uid}-status`

  /**
   * The fourteen kinds, in the reader's alphabetical order.
   *
   * Sorted by the RENDERED label rather than reordered by hand: a hand-written
   * order would be a second copy of SOURCE_DOCUMENT_KINDS, and the day a
   * fifteenth kind is added to the constant it would be missing from this list
   * with nothing failing to say so. Sorting is derived, so it cannot go stale.
   *
   * The constant's own order is grouped by migration (0048's six, then 0050's
   * eight) which puts "Other" sixth — findable by nobody scanning a dropdown.
   */
  const kinds = useMemo(() => {
    const collator = new Intl.Collator(locale)
    return [...SOURCE_DOCUMENT_KINDS].sort((a, b) => collator.compare(tKinds(a), tKinds(b)))
  }, [locale, tKinds])

  function chooseFile(chosen: File | null) {
    setFile(chosen)
    setOutcome(null)
    setClientFailure(null)
    setStopped(null)
    setProblem(chosen ? fileProblem(chosen) : null)

    // A courtesy inside a courtesy: the title is required and the filename is
    // almost always the right first draft of it. Only ever fills an EMPTY
    // title, so it can never overwrite something typed.
    if (chosen && title.trim() === '') {
      setTitle(chosen.name.replace(/\.[^.]+$/, '').trim().slice(0, 300))
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    if (!file) {
      setProblem('chooseFile')
      return
    }

    // Re-run rather than trust the state set at pick time. It is the same call
    // and it costs nothing, and it means a future code path that sets `file`
    // without going through chooseFile cannot skip the check.
    const found = fileProblem(file)
    if (found) {
      setProblem(found)
      return
    }
    setProblem(null)
    setOutcome(null)
    setClientFailure(null)
    setStopped(null)

    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal

    startTransition(async () => {
      try {
        setPhase('checking')
        setFraction(null)

        // The sniff, and then the hash — in that order, because the sniff reads
        // eight bytes and the hash reads all of them. No point digesting 92 MB
        // to then refuse the file for being a renamed .docx.
        if (await bytesDisagree(file)) {
          setProblem('mismatch')
          return
        }

        /*
         * ┌───────────────────────────────────────────────────────────────────┐
         * │ HASHED IN CHUNKS, WITH A FIGURE, AND NOT WITH crypto.subtle.       │
         * │                                                                   │
         * │ WebCrypto's digest is one-shot: it takes the whole file as one     │
         * │ ArrayBuffer and emits no events. That is 92 MB of heap in a tab    │
         * │ that may be a phone, and a dialog that sits still for the whole    │
         * │ digest — which reads as a crash, and a crash's next move is        │
         * │ closing the tab. sha256File reads 2 MiB at a time and reports a    │
         * │ fraction after each; the box at the top of src/lib/crypto/         │
         * │ sha256.ts is the full argument, including what hand-writing it     │
         * │ costs and the test that pays for it.                              │
         * │                                                                   │
         * │ null means STOPPED, and a rejection means the file could not be    │
         * │ READ — moved, renamed or unmounted since it was chosen. Two        │
         * │ different answers, and the person can act on the second one.       │
         * └───────────────────────────────────────────────────────────────────┘
         */
        setFraction(0)
        let sha256: string | null
        try {
          sha256 = await sha256File(file, { signal, onProgress: setFraction })
        } catch {
          setProblem('unreadable')
          return
        }
        if (sha256 === null) {
          // Nothing was reserved and nothing was sent. Nothing to explain.
          setStopped('clean')
          return
        }

        // 1. The ticket. Everything the server used to read off the File is a
        //    claim from here on, and the action's boxes say what each one is
        //    still worth. The phase does not change — this is a few hundred
        //    bytes and a moment — but the bar goes indeterminate, because
        //    leaving it at 100% would say the next step had already finished.
        setFraction(null)
        const ticket = await createUploadTicket({
          kind: kind as SourceDocumentKind,
          title,
          // '' would fail uploadSchema's optional string; undefined is the
          // shape "nobody filled this in" has.
          description: description.trim() || undefined,
          filename: file.name,
          byteSize: file.size,
          declaredMimeType: file.type,
          sha256,
        })

        if (!ticket.ok) {
          setOutcome(ticket)
          return
        }

        // 2. The bytes, straight at Storage.
        setPhase('sending')
        setFraction(0)
        const transfer = await putSignedUpload(ticket.signedUrl, file, {
          signal,
          onProgress: setFraction,
        })

        /*
         * ╔═══════════════════════════════════════════════════════════════════╗
         * ║ 3. FINALISE RUNS WHATEVER THE TRANSFER SAID — INCLUDING AFTER A   ║
         * ║    STOP.                                                          ║
         * ║                                                                   ║
         * ║ The PUT's own verdict is not the decider, because it is wrong in  ║
         * ║ both directions often enough to be useless as one: a connection   ║
         * ║ dropped after the last byte reports a failure for an upload that  ║
         * ║ completed, and an abort pressed at 99% may abort nothing.         ║
         * ║ finaliseUpload asks Storage whether the object is actually there, ║
         * ║ which is the question that matters, and it is the only place that ║
         * ║ decides what a half-done upload becomes — queue it, or tombstone  ║
         * ║ the row it reserved.                                              ║
         * ║                                                                   ║
         * ║ NOT calling it would be the worst option available. The reserved  ║
         * ║ row would sit at 'uploaded' with no bytes, and because dedupe now ║
         * ║ runs FIRST, the next attempt at the same file would come back     ║
         * ║ "you already have this" pointing at it. That is exactly why Stop  ║
         * ║ falls through to here rather than returning early.                ║
         * ╚═══════════════════════════════════════════════════════════════════╝
         */
        setPhase('finishing')
        setFraction(null)

        let result: FinaliseUploadResult
        try {
          result = await finaliseUpload(ticket.documentId)
        } catch (error) {
          // Could not even ask. If the transfer had already failed, this
          // component KNOWS the document is not stored and says so in the
          // person's own language; if it had succeeded, this is something else
          // going wrong and is not ours to describe.
          if (!transfer.ok) {
            setClientFailure('notStored')
            return
          }
          throw error
        }

        if (result.ok) {
          /*
           * Reached even after a Stop, and deliberately. If the object is in
           * the bucket then the upload finished — the abort landed after the
           * last byte — and the document really has been queued. Telling
           * somebody it was cancelled when it was not is the one lie this
           * sequence must not tell, so the truth wins over the button they
           * pressed.
           */
          // The title is in the toast because by the time it appears the dialog
          // is gone and the list has re-rendered — "uploaded" alone leaves the
          // person scanning the table for which row is theirs.
          toast.success(t('success', { title: title.trim() || file.name }))
          onUploaded()
          // revalidatePath('/guide') already re-renders the route in the
          // action's response. refresh() is what makes that land when this
          // dialog is opened from a page the router has cached — the same
          // belt-and-braces every other mutation in this codebase uses.
          router.refresh()
          return
        }

        if (!transfer.ok && transfer.reason === 'aborted') {
          // Stopped on purpose. finaliseUpload has just tombstoned the row, so
          // this is neutral information rather than an error — and the hint
          // beside it warns about the tombstone, which keeps the
          // (company_id, sha256) slot and will answer the retry as a duplicate.
          setStopped('reserved')
          return
        }

        if (!transfer.ok) {
          /*
           * The transfer genuinely failed, so the answer is a FACT this
           * component established: nothing is stored and the upload can simply
           * be repeated. It is said with a message key rather than with the
           * server's sentence because a key is translated and the server's
           * prose is English — see the KNOWN GAP note beside `outcome`.
           *
           * WHAT THAT DROPS: in the rare case where finaliseUpload could not
           * tombstone the row either, its message carries a document id to
           * quote. That id is in the browser console's failed request and in
           * the row itself; a person reading a red box in Gujarati is better
           * served by a sentence they can read.
           */
          setClientFailure('notStored')
          return
        }

        setOutcome(result)
      } finally {
        // In a finally, because every early return above leaves the button
        // disabled and the status region talking otherwise — and so does a
        // thrown AuthorizationError from either action.
        abortRef.current = null
        setPhase(null)
        setFraction(null)
      }
    })
  }

  const problemMessage = problem
    ? t(problem, { limit: MAX_UPLOAD_MB, size: fileSizeMb(file) })
    : null

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE LIVE REGION SAYS THE PHASE. THE PERCENTAGE IS NOT IN IT.            │
   * │                                                                        │
   * │ Both are required — progress has to be text and not only a bar — but    │
   * │ they cannot be the same text. A role="status" whose content changes on  │
   * │ every progress event is a screen reader saying "one percent, two        │
   * │ percent, three percent" for four minutes, which is worse than silence   │
   * │ and is what makes people turn the announcements off.                    │
   * │                                                                        │
   * │ So this sentence changes three times for the whole sequence and is what │
   * │ gets announced, while the live percentage is rendered as ordinary text  │
   * │ beside the bar — readable at any moment, and repeated in the            │
   * │ progressbar's aria-valuenow, which assistive technology reports on      │
   * │ demand rather than interrupting with.                                   │
   * │                                                                        │
   * │ One sentence per leg, because they take very different lengths of time. │
   * │ "Uploading…" for the whole thing would sit unchanged through a digest   │
   * │ of 92 MB that produces no network traffic at all.                       │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const phaseMessage =
    phase === 'checking'
      ? t('preparingHint')
      : phase === 'sending'
        ? t('uploadingHint')
        : phase === 'finishing'
          ? t('finishingHint')
          : ''

  const percent = fraction === null ? null : Math.min(100, Math.max(0, Math.round(fraction * 100)))
  const percentText = percent === null ? null : t('percent', { percent })

  return (
    <form onSubmit={submit} aria-busy={busy} className="space-y-4">
      {/*
       * ┌───────────────────────────────────────────────────────────────────┐
       * │ A DUPLICATE IS NOT RED, AND THAT IS THE POINT OF THE DISCRIMINANT.│
       * │                                                                   │
       * │ "You already have this" is the answer somebody wanted — usually   │
       * │ they were looking for the document, not making a second copy of   │
       * │ it. Painting it destructive tells them they did something wrong.  │
       * │                                                                   │
       * │ role="status" and not role="alert" for the same reason: alert is  │
       * │ assertive and interrupts, and this is information that arrived    │
       * │ because they asked for it.                                        │
       * │                                                                   │
       * │ It names the document and does not link to it. There is no        │
       * │ document page yet — the library's own rows are not links either,  │
       * │ and the guide page says why: a row that looks clickable and 404s  │
       * │ is worse than one that does not.                                  │
       * │                                                                   │
       * │ It now arrives BEFORE any bytes are sent rather than after all of │
       * │ them, because the hash is computed here and the server answers    │
       * │ the question first.                                               │
       * └───────────────────────────────────────────────────────────────────┘
       */}
      {outcome?.reason === 'duplicate' && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-sm"
        >
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            {t('duplicate', { title: outcome.existingTitle })}{' '}
            <span className="text-muted-foreground">{t('duplicateHint')}</span>
          </span>
        </div>
      )}

      {/*
       * Stopping is not a failure either. Same neutral treatment as the
       * duplicate, and the same role="status": the person did this on purpose
       * and does not need to be alarmed about it.
       *
       * The hint appears only for a stop that had already reserved a row,
       * because that is the only one with a consequence — finaliseUpload
       * tombstones the row, the tombstone keeps the (company_id, sha256) slot,
       * and re-uploading the same file will therefore be answered as a
       * duplicate of something that is in the recycle bin.
       */}
      {stopped && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-sm"
        >
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            {t('cancelled')}
            {stopped === 'reserved' && (
              <> <span className="text-muted-foreground">{t('cancelledHint')}</span></>
            )}
          </span>
        </div>
      )}

      {/*
       * Every other refusal. InlineError is already role="alert" — that is the
       * reason the component exists — so a failure that arrives without focus
       * moving is still read out.
       *
       * The message is the action's own, verbatim, and not a key looked up by
       * `reason`. The three reasons are not three sentences: 'failed' alone
       * covers a company-less account, an empty file, a document that could not
       * be found and one that was saved but not queued, and two of those carry
       * an id to quote. Keying off the discriminant would flatten all of that
       * into three generic lines — exactly the "upload failed" this result type
       * was shaped to avoid.
       *
       * KNOWN GAP: those strings are English-only, because they are composed
       * server-side. Fixing it properly means the actions returning a key and
       * params rather than prose, which is a change to their contract and not
       * something this form can do from the outside. `clientFailure` below is
       * the half this component CAN say in the reader's language, because it is
       * the half this component worked out for itself.
       */}
      {outcome && outcome.reason !== 'duplicate' && <InlineError>{outcome.message}</InlineError>}
      {clientFailure && <InlineError>{t(clientFailure)}</InlineError>}

      <div className="space-y-2">
        <Label htmlFor={fileId}>{t('fileLabel')}</Label>
        {/*
         * A real <input type="file"> with a real <label for>. Not a styled
         * <div> with a click handler, and not a bare button that opens a
         * picker: neither is focusable, announceable or operable by keyboard
         * without rebuilding what the browser already gives away.
         *
         * `required` is the browser's own affordance and stays even though the
         * explicit check below is what produces a translated sentence — it is
         * the thing that stops an empty submit from ever reaching the check.
         */}
        <Input
          id={fileId}
          type="file"
          required
          accept={ACCEPT_ATTRIBUTE}
          disabled={busy}
          aria-invalid={problemMessage ? true : undefined}
          aria-describedby={problemMessage ? `${fileHintId} ${fileErrorId}` : fileHintId}
          onChange={(event) => chooseFile(event.currentTarget.files?.[0] ?? null)}
        />
        <p id={fileHintId} className="text-xs text-muted-foreground">
          {t('fileHint', { limit: MAX_UPLOAD_MB })}
        </p>
        {/* The wrapper carries the id because InlineError takes only children
            and className. aria-describedby needs an element to point at, and
            pointing at the wrapper reads the message inside it. */}
        {problemMessage && (
          <div id={fileErrorId}>
            <InlineError>{problemMessage}</InlineError>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={kindId}>{t('kindLabel')}</Label>
        {/*
         * A native <select>, matching every other select in this codebase.
         *
         * THE PLACEHOLDER IS NOT DECORATION. Without an empty first option a
         * select arrives pre-set to whatever sorts first, and this field is
         * the fork in the road: 'question_paper' goes OCR -> question / answer
         * / marks straight into the bank, and everything else goes OCR ->
         * knowledge units -> generation. Defaulting it would file documents
         * down the wrong road silently, and `required` on an empty value is
         * what makes the choice deliberate.
         */}
        <select
          id={kindId}
          required
          value={kind}
          disabled={busy}
          aria-describedby={kindHintId}
          onChange={(event) => setKind(event.currentTarget.value as SourceDocumentKind)}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50"
        >
          <option value="">{t('kindPlaceholder')}</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {tKinds(value)}
            </option>
          ))}
        </select>
        <p id={kindHintId} className="text-xs text-muted-foreground">
          {t('kindHint')}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={titleId}>{t('titleLabel')}</Label>
        {/* maxLength mirrors uploadSchema's .max(300). It stops the typing
            rather than refusing the upload afterwards; the schema is still the
            rule and still runs. */}
        <Input
          id={titleId}
          required
          maxLength={300}
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={descriptionId}>{t('descriptionLabel')}</Label>
        <Textarea
          id={descriptionId}
          maxLength={2000}
          rows={3}
          value={description}
          disabled={busy}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </div>

      <div className="space-y-2">
        {/*
         * THE PENDING STATE IS A SENTENCE, NOT A SPINNER.
         *
         * A spinning icon is invisible to a screen reader and meaningless to
         * anyone who has turned animation off, and the button's own label
         * change is not reliably announced because the button is disabled at
         * the same moment and may lose focus.
         *
         * So the region is ALWAYS in the DOM and only its text changes. A
         * role="status" element inserted at the same instant as its content is
         * announced inconsistently across screen readers; one that already
         * exists and gains text is announced reliably. That is the whole reason
         * for the empty string rather than a conditional render.
         */}
        <p id={statusId} role="status" className="text-sm text-muted-foreground">
          {phaseMessage}
        </p>

        {/*
         * The bar, and the percentage as text beside it.
         *
         * This block IS conditionally rendered, unlike the region above, and
         * that is fine: it is not a live region, so nothing has to be listening
         * to it when it appears. Its accessible name is the sentence above —
         * aria-labelledby rather than a label of its own, so the bar and the
         * announcement can never describe different steps.
         *
         * aria-valuenow is omitted entirely when the total is unknown, which is
         * how ARIA spells an indeterminate progressbar. Inventing a number
         * there would be a bar that moves without meaning.
         */}
        {phase !== null && (
          <div className="space-y-1.5">
            {percentText && (
              <p className="text-right text-xs tabular-nums text-muted-foreground">{percentText}</p>
            )}
            <div
              role="progressbar"
              aria-labelledby={statusId}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(percent === null
                ? {}
                : { 'aria-valuenow': percent, 'aria-valuetext': percentText ?? undefined })}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className={
                  percent === null
                    ? 'h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse'
                    : 'h-full rounded-full bg-primary transition-[width] duration-150'
                }
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <DialogFooter>
        {/*
         * TWO DIFFERENT CANCELS, AND THEY MUST NOT BE THE SAME BUTTON.
         *
         * Idle, "Cancel" closes the dialog and throws away a half-filled form.
         * Busy, that is not what anybody means: they mean stop the upload. Stop
         * aborts the transfer, and the sequence then falls through to
         * finaliseUpload, which removes the row that was reserved — so pressing
         * it leaves nothing behind rather than leaving a document that can
         * never be re-uploaded.
         *
         * It is disabled during 'finishing' because there is nothing left to
         * abort by then: the bytes have arrived and the server is opening a
         * batch. Disabled rather than removed, so the footer does not reflow at
         * the exact moment somebody is reaching for it.
         */}
        {busy ? (
          <Button
            type="button"
            variant="outline"
            disabled={phase === 'finishing'}
            onClick={() => abortRef.current?.abort()}
          >
            {t('stop')}
          </Button>
        ) : (
          <DialogClose render={<Button type="button" variant="outline" />}>{t('cancel')}</DialogClose>
        )}
        <Button type="submit" disabled={busy || problemMessage !== null}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {busy ? t('uploading') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The chosen file's size in whole MB, for the "too large" sentence. */
function fileSizeMb(file: File | null): number {
  return file ? Math.round(file.size / (1024 * 1024)) : 0
}
