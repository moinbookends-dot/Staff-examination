# Question import format

The specification for the 3,000-question dataset generated outside this
application.

**This document and `src/lib/bank/import/format.ts` describe the same thing.**
The schema is the binding version; this is the readable one. Anything the
schema accepts will load, and anything it rejects is reported per row with the
row number and the reason, before a single row is written.

Validate a file before handing it over:

```bash
node scripts/check-import.mjs path/to/questions.json
```

---

## 1 — File shape

Three shapes are accepted, so no reformatting is needed:

```jsonc
// A — the canonical envelope
{ "formatVersion": 1, "questions": [ /* … */ ] }

// B — a bare array
[ /* … */ ]

// C — JSON Lines, one question object per line
{"externalId":"easy-0001", …}
{"externalId":"easy-0002", …}
```

UTF-8, no BOM. Hindi and Gujarati go in as ordinary UTF-8 text.

---

## 2 — A complete MCQ

```json
{
  "externalId": "easy-0001",
  "difficulty": "easy",
  "type": "mcq",
  "topic": "food-safety",
  "correctOption": "C",
  "reference": { "document": "Capiche Master Cookbook", "page": 112 },

  "en": {
    "question": "<English question text>",
    "options": { "A": "<option A>", "B": "<option B>", "C": "<option C>", "D": "<option D>" },
    "explanation": "<why C is correct — optional>"
  },
  "hi": {
    "question": "<हिन्दी प्रश्न>",
    "options": { "A": "<विकल्प A>", "B": "<विकल्प B>", "C": "<विकल्प C>", "D": "<विकल्प D>" },
    "explanation": "<वैकल्पिक>"
  },
  "gu": {
    "question": "<ગુજરાતી પ્રશ્ન>",
    "options": { "A": "<ઓપ્શન A>", "B": "<ઓપ્શન B>", "C": "<ઓપ્શન C>", "D": "<ઓપ્શન D>" },
    "explanation": "<વૈકલ્પિક>"
  }
}
```

## 3 — A complete short answer

```json
{
  "externalId": "hard-0001",
  "difficulty": "hard",
  "type": "short_answer",
  "topic": "storage",

  "en": { "question": "<English question>", "answer": "<one to two lines>", "explanation": "<optional>" },
  "hi": { "question": "<हिन्दी प्रश्न>", "answer": "<एक-दो पंक्ति>" },
  "gu": { "question": "<ગુજરાતી પ્રશ્ન>", "answer": "<એક-બે લીટી>" }
}
```

---

## 4 — Field reference

| Field | Required | Notes |
|:--|:--|:--|
| `externalId` | recommended | **Your** identifier. Without it, a re-import cannot tell a corrected question from a new one and creates a duplicate. |
| `difficulty` | **yes** | `easy` \| `medium` \| `hard`. See §7. |
| `type` | **yes** | `mcq` \| `short_answer` |
| `status` | no | `active` (default) \| `draft` \| `archived`. See §5.1. |
| `topic` | no | Slug or display name — `food-safety` and `Food Safety` both match. Unknown topics are **rejected**, not created. |
| `correctOption` | MCQ only | `A` \| `B` \| `C` \| `D`. See §6. |
| `reference.document` | no | Matched against the library by title. |
| `reference.page` | no | Requires `reference.document`. |
| `en` | **yes** | |
| `hi`, `gu` | no | See §5. |

Per language:

| Field | Required | Limit |
|:--|:--|:--|
| `question` | **yes** | 3–2000 characters |
| `options` | MCQ only | exactly A, B, C, D — all four non-empty, ≤500 each |
| `answer` | short answer only | 1–**400** characters (≈ two lines) |
| `explanation` | no | ≤2000 characters |

**Unknown keys are rejected.** A generator emitting `answerText` instead of
`answer` is told so, rather than having the field silently dropped and the
question imported with no answer.

---

## 5 — Languages

**English is required. Hindi and Gujarati are not.**

Not because translations are optional in the product — a paper is printed in
every required language — but because *which* languages are required is a
setting (`exam_settings.required_locales`) that currently reads `{en}`. A
question missing a required language imports as a **draft**, is counted in the
import summary, and cannot appear on a paper until it is completed.

So an English-first dataset loads cleanly, and adding the translations later is
a second import keyed on `externalId`.

### 5.1 — `status`

Defaults to **`active`**, because the dataset is curated before it arrives.
Defaulting to `draft` would import 3,000 unusable questions and require a bulk
activation nobody asked for.

A row that asks for `active` while missing a **required** language is **held
back as a draft**, not rejected — the database refuses to activate an
incomplete question, and losing a good row over a translation that is coming
later would be the wrong trade. The report counts these separately.

---

## 6 — `correctOption` is a position, never text

The correct answer is stored as **A/B/C/D on the language-neutral row**, so
there is nowhere for a translation to record a different one. A translation
therefore cannot change what is correct — not by mistake, not by a bad
generator.

**The consequence, which the generator must honour:** option **order must match
across languages**. Hindi option B has to be the translation of English option
B. If the languages disagree about which option is which, `correctOption` means
a different thing on each paper.

---

## 7 — Difficulty

`difficulty` is taken exactly as given. **Nothing in this system infers,
suggests, adjusts or validates it** — there is no classifier, no default, no
Bloom's taxonomy, and no check that a question "looks" like its level.

What Easy, Medium and Hard mean is defined by your separate Difficulty Rules
document, which is the single source of truth. This importer's only
responsibility is to store the level you assigned.

---

## 8 — What gets rejected, and what merely gets reported

**Rejected** (the row does not import; every problem with it is listed):

- unknown `difficulty`, `type` or `correctOption`
- missing or too-short `question`; missing `en`
- an MCQ without four options or without `correctOption`
- a short answer without `answer`, or carrying `options`/`correctOption`
- an answer over 400 characters
- an unknown `topic`
- an unknown key anywhere
- `reference.page` without `reference.document`

**Reported, not rejected:**

- **Duplicates within the file** — same English question at the same
  difficulty. The first is imported and the rest are listed with both row
  numbers. A generator repeating itself is a quiet failure at 3,000 rows.
- **Missing translations** — imports as a draft.
- **Level imbalance** — a 3,000-row file that turns out to be 1,400 Easy and
  600 Hard is shown before it lands, not discovered when a Hard paper cannot be
  generated.

A file with some bad rows still imports its good ones. At this scale, demanding
perfection means nothing ever loads.

### 8.1 — The report

Every run — CLI or screen — produces the same report:

```
  Outcome
    imported          2      new questions
    updated           0      matched an existing externalId
    rejected          2      not written; see the causes below
    duplicate         0      repeated within this file; the first is kept

  Rejected by cause
    invalid-difficulty             1
    invalid-option-structure       1

  Status
    active            0
    draft             2
    2 asked for active and were held as drafts — a required language is missing

  Languages    (of the 2 accepted rows; required: en, hi, gu)
    en                2
    hi                1   1 without it
    gu                0   2 without it

  Unknown topics   Unknown Topic
```

**"Rejected by cause" is the number that matters at 3,000 rows.** A flat list of
412 sentences is a log; `380 invalid-option-structure` tells you the one thing
to change in your generator to recover most of the file.

The causes are: `invalid-difficulty`, `invalid-type`, `invalid-status`,
`missing-english`, `invalid-option-structure`, `invalid-answer`,
`unknown-topic`, `invalid-reference`, `malformed`.

---

## 9 — Duplicates against the existing bank

A question is a duplicate if its **English text matches an existing question at
the same difficulty, in the same brand**. That is a database constraint, so it
is refused outright rather than silently creating a second copy.

Note **brand**: each brand keeps its own bank and there are no shared
questions. A question that applies to both brands is imported once per brand.

---

## 10 — Topics

Seeded and editable. Use the slug or the display name:

`pizza` · `pasta` · `burger` · `salad` · `sauces` · `desserts` ·
`kitchen-hygiene` · `food-safety` · `preparation` · `storage` · `cleaning` ·
`kitchen-equipment` · `recipes` · `cooking-techniques`

Topics are organisational labels only. Nothing in paper generation reads one,
and no paper prints one — so adding or renaming them cannot affect a generated
paper.
