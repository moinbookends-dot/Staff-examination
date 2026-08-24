import type {
  BankLocale,
  Difficulty,
  OptionKey,
  QuestionStatus,
  QuestionType,
} from './vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The shapes the Question Bank's UI speaks.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DELIBERATELY NOT database.types.ts ROWS.                                  │
 * │                                                                           │
 * │ Every component below the data layer takes these, and the server actions  │
 * │ map generated rows onto them. Three reasons, in the order they matter:    │
 * │                                                                           │
 * │  1. THE UUID BOUNDARY IS EXPRESSIBLE. `id` is optional on                 │
 * │     BankQuestionRow, and it is populated only for a caller holding        │
 * │     bank.read_uuid. A generated Row type has `id: string` unconditionally,│
 * │     so every component would receive an id it must remember not to        │
 * │     render. Here the type itself says "you may not have this".            │
 * │                                                                           │
 * │  2. The three languages are a map, not six columns joined at the call     │
 * │     site. Components iterate BANK_LOCALES; they never name a locale.      │
 * │                                                                           │
 * │  3. The UI compiles before the migration is applied. Generated types come │
 * │     from the LIVE schema, so a component typed against them cannot be     │
 * │     written until somebody has pushed — which is a poor reason for the    │
 * │     editor form to be blocked.                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** One language of one question, as rendered. */
export interface BankQuestionText {
  question: string
  optionA: string | null
  optionB: string | null
  optionC: string | null
  optionD: string | null
  answerText: string | null
}

/**
 * A question as the bank list and the editor see it.
 *
 * `texts` is partial because a draft legitimately has only English — that is
 * the normal state of a question until somebody translates it, and a
 * non-optional map would force every consumer to invent empty strings.
 */
export interface BankQuestionRow {
  /**
   * ╔═════════════════════════════════════════════════════════════════════════╗
   * ║ PRESENT ONLY FOR AN EDITOR. Everyone else gets `undefined`, and it is    ║
   * ║ absent from the payload rather than blanked — a field stripped by the    ║
   * ║ server cannot be recovered by anything running in the browser.           ║
   * ║                                                                          ║
   * ║ Do not make this required to satisfy a React `key`. Use `rowKey` below;  ║
   * ║ that is what it is for.                                                  ║
   * ╚═════════════════════════════════════════════════════════════════════════╝
   */
  id?: string

  /**
   * A stable per-render handle for React keys and for addressing a row in a
   * bulk selection, safe to send to anybody.
   *
   * For an Editor this IS the uuid, because they may see it and a second
   * identifier would be a second thing to keep in step. For everybody else it
   * is an opaque server-minted token that means nothing outside this response.
   */
  rowKey: string

  brandId: string
  brandName: string

  difficulty: Difficulty
  qtype: QuestionType
  status: QuestionStatus

  topicId: string | null
  topicName: string | null

  /** Null for a short answer. The position, never the text — see 0054. */
  correctOption: OptionKey | null

  texts: Partial<Record<BankLocale, BankQuestionText>>

  /**
   * Which languages are fully written. Computed on the server from the same
   * function the form uses, so the badge and the Publish button cannot
   * disagree about whether a question is ready.
   */
  completeLocales: BankLocale[]

  createdByName: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** A page of the bank, with the count the pager needs. */
export interface BankQuestionPage {
  /**
   * The narrow list shape, not BankQuestionRow.
   *
   * A list page shows the English stem and a few chips. Carrying every
   * translation of every question — which BankQuestionRow does — would fetch
   * three languages of text per row to render one of them.
   */
  rows: BankQuestionListRow[]
  /** The TOTAL matching the filter, not the length of `rows`. */
  total: number
  page: number
  pageSize: number
  /** True when the caller may see uuids, so the table can show the column. */
  showsUuid: boolean
}

/** A topic, as the picker and the manage screen see it. */
export interface BankTopic {
  id: string
  name: string
  slug: string
  sortOrder: number
  /** How many undeleted questions are filed here. Drives "in use" warnings. */
  questionCount: number
}

/** A brand, for the selector. Brand is mandatory on every question. */
export interface BankBrand {
  id: string
  name: string
  /** URL-safe identifier — what an import file's `brand` field names. */
  slug: string
}

/**
 * A reference document an Editor can cite.
 *
 * Only ever cookbooks and manuals that finished uploading — a citation
 * pointing at a document whose bytes never arrived is a broken link on a
 * question, and the Editor has no way to tell from the picker.
 */
/**
 * Everything the editor form needs besides the question itself.
 *
 * One object rather than four props, because all four are fetched together in
 * the page's server component and threading them separately through the form,
 * its tabs and its pickers is four chances to forget one.
 */
export interface BankFormOptions {
  brands: BankBrand[]
  topics: BankTopic[]
  /** Whether to render the UUID panel. Server-decided, never inferred. */
  showsUuid: boolean

  /**
   * Which languages a question must be written in before it can be published.
   *
   * Read from exam_settings.required_locales — {en} while the bank is being
   * authored in English, {en,hi,gu} once it is translated. The form gates
   * Publish on this and the database trigger enforces the same set, so the
   * button and the write cannot disagree.
   *
   * The other tabs are still offered when they are not required: an Editor who
   * happens to know the Hindi should be able to write it, and doing so early
   * costs nothing and saves a second pass.
   */
  requiredLocales: BankLocale[]

  /**
   * The company's display names for the three levels
   * (exam_settings.label_*). Presentation only — the enum values never change.
   */
  difficultyLabels: Record<Difficulty, string>
}

/**
 * One row of the Question Bank list.
 *
 * Deliberately narrower than BankQuestionRow: the list shows the English stem
 * and some chips, so fetching every translation of every question to render a
 * page of 25 would be a large query for text nobody sees.
 */
export interface BankQuestionListRow {
  /** Present ONLY for a bank.read_uuid holder. Server-decided. */
  id?: string
  /** The React key. Always present — it is not the disclosed UUID. */
  rowKey: string
  brandName: string
  difficulty: Difficulty
  qtype: QuestionType
  status: QuestionStatus
  topicName: string | null
  /** The English stem. Empty when a draft has no English text yet. */
  question: string
  completeLocales: BankLocale[]
  createdAt: string
}

/**
 * What the import screen needs before a file is chosen.
 *
 * A narrower set than BankFormOptions: the importer never renders a reference
 * picker, and it needs topic SLUGS rather than topic records because a file
 * names a topic by slug and analyse.ts matches on that.
 */
export interface BankImportOptions {
  brands: BankBrand[]
  /** Slugs only — what the file names, and what analyseImport matches. */
  topicSlugs: string[]
  requiredLocales: BankLocale[]
  difficultyLabels: Record<Difficulty, string>
  /**
   * The curator's own ids already in the bank, so the dry run can split new
   * from updated. Not database UUIDs — see loadImportOptions.
   */
  existingExternalIds: string[]
  /**
   * Every question already in this brand's bank, as level + English text.
   *
   * What lets a translation file recognise the questions it is adding to. A
   * bank imported without externalIds has nothing else to match on, and
   * without this every row of a re-import reads as new.
   */
  existingQuestions: { key: string; qtype: QuestionType }[]
}

/**
 * What the PAPER tab needs before a file is chosen.
 *
 * Separate from BankImportOptions and deliberately not folded into it. The two
 * tabs need different things and one of them is expensive: the JSON tab needs
 * every externalId already in the bank so its pure dry run can split new from
 * updated, while the paper tab looks its ids up on demand through
 * resolvePaperTargets() — because a paper names a thousand ids and the answer
 * has to include the bank's own answer letter for each, which no list of ids
 * can carry.
 *
 * Topics arrive as RECORDS rather than slugs, because the topic mapper shows a
 * person the topic's NAME and stores its slug.
 */
export interface PaperImportOptions {
  brands: BankBrand[]
  topics: { name: string; slug: string }[]
  requiredLocales: BankLocale[]
  difficultyLabels: Record<Difficulty, string>
}

/** One recorded import, for the history panel. */
export interface BankImportRun {
  id: string
  occurredAt: string
  kind: 'json' | 'paper'
  locale: BankLocale | null
  filename: string
  answerKeyFilename: string | null
  brandName: string
  actorName: string
  detected: number
  created: number
  updated: number
  skipped: number
  rejected: number
  warnings: number
  status: 'completed' | 'partial' | 'failed'
  message: string | null
}

/**
 * The result shape every bank mutation returns.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A DUPLICATE IS INFORMATION, NOT AN ERROR — the same argument the upload   │
 * │ path makes. "You already have this question, here it is" is a useful      │
 * │ answer and the person usually wanted the existing one; flattening it into │
 * │ a red string would leave the UI nothing to link to.                       │
 * │                                                                           │
 * │ 'incomplete' is separated for the same reason: it is not a failure so     │
 * │ much as a list of what is left to do, and the form uses it to point at    │
 * │ the language tabs that still need writing.                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export type BankMutationResult =
  | { ok: true; id: string; rowKey: string }
  | { ok: false; reason: 'duplicate'; existingRowKey: string | null; message: string }
  | { ok: false; reason: 'incomplete'; missingLocales: BankLocale[]; message: string }
  | { ok: false; reason: 'denied' | 'not-found' | 'failed'; message: string }

/** The outcome of a bulk operation, counted rather than assumed. */
export interface BankBulkResult {
  ok: boolean
  /**
   * Counted, never inferred from the absence of an error. RLS refuses by
   * FILTERING, so an update the policies do not admit returns no error and
   * changes nothing — which is how the old bank reported "Question removed"
   * for a question it had never touched.
   */
  affected: number
  requested: number
  message: string
}
