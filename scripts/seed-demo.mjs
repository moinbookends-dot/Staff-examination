/**
 * Demo content: a question bank with real questions, and exams to show.
 *
 *   npm run db:demo
 *
 * Separate from supabase/seed.sql on purpose. That file is STRUCTURAL — company,
 * brands, outlets, roles, permissions, the category tree — everything the app
 * needs to function at all, and it runs in CI. This is illustrative content for
 * showing the product to somebody, and CI must never depend on it.
 *
 * Idempotent: fixed ids and ON CONFLICT DO NOTHING throughout, so re-running is
 * safe and will not duplicate anything.
 *
 * Undo with:  node scripts/seed-demo.mjs --clean
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

function readEnvLocal() {
  const raw = readFileSync(resolve(root, '.env.local'), 'utf-8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const env = readEnvLocal()
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]

const db = new Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

const COMPANY = '00000000-0000-0000-0000-00000000c001'
const OUTLET_AIKO = '00000000-0000-0000-0000-00000000a001'
const CAT = {
  foodSafety: '00000000-0000-0000-0000-00000000f001',
  hygiene: '00000000-0000-0000-0000-00000000f002',
  knives: '00000000-0000-0000-0000-00000000f003',
  service: '00000000-0000-0000-0000-00000000f004',
  bar: '00000000-0000-0000-0000-00000000f005',
  allergens: '00000000-0000-0000-0000-00000000f006',
  temperature: '00000000-0000-0000-0000-00000000fa01',
}
// Demo ids all share the d0…  prefix so --clean can find them.
const q = (n) => `00000000-0000-0000-0000-0000d0000${String(n).padStart(3, '0')}`
const EXAM_PUBLISHED = '00000000-0000-0000-0000-0000d0e00001'
const EXAM_DRAFT = '00000000-0000-0000-0000-0000d0e00002'

/**
 * Questions across six formats, because the format engine is the interesting
 * part of the product and a bank of nothing but multiple choice does not show
 * it. Content is real kitchen material, not lorem ipsum — a demo where the
 * questions are obviously fake invites the audience to discount everything else.
 */
const QUESTIONS = [
  {
    n: 1, cat: CAT.temperature, difficulty: 2, marks: 2, secs: 45,
    type: 'mcq_single', format: 'choice_single',
    stem: 'What is the minimum safe internal temperature for cooked chicken?',
    content: { format: 'choice_single', choices: [
      { id: 'a', text: '63°C' }, { id: 'b', text: '70°C' },
      { id: 'c', text: '74°C' }, { id: 'd', text: '82°C' }] },
    key: { format: 'choice_single', correct: 'c' },
    explanation: 'Poultry must reach 74°C throughout to destroy Salmonella and Campylobacter.',
  },
  {
    n: 2, cat: CAT.temperature, difficulty: 3, marks: 2, secs: 45,
    type: 'mcq_single', format: 'choice_single',
    stem: 'Cold food must be held below which temperature?',
    content: { format: 'choice_single', choices: [
      { id: 'a', text: '2°C' }, { id: 'b', text: '5°C' },
      { id: 'c', text: '8°C' }, { id: 'd', text: '12°C' }] },
    key: { format: 'choice_single', correct: 'b' },
  },
  {
    n: 3, cat: CAT.foodSafety, difficulty: 3, marks: 3, secs: 90,
    type: 'mcq_multi', format: 'choice_multi',
    stem: 'Which of these are steps in preventing cross-contamination?',
    content: { format: 'choice_multi', choices: [
      { id: 'a', text: 'Separate boards for raw and ready-to-eat' },
      { id: 'b', text: 'Wash hands between tasks' },
      { id: 'c', text: 'Store raw meat above salad' },
      { id: 'd', text: 'Sanitise surfaces after raw prep' }] },
    key: { format: 'choice_multi', correct: ['a', 'b', 'd'], partialCredit: true },
    explanation: 'Raw meat is stored BELOW ready-to-eat food so drips cannot fall onto it.',
  },
  {
    n: 4, cat: CAT.foodSafety, difficulty: 2, marks: 1, secs: 30,
    type: 'true_false', format: 'boolean',
    stem: 'Reheated food only needs to be warm to the touch before serving.',
    content: { format: 'boolean' },
    key: { format: 'boolean', correct: false },
    explanation: 'Reheated food must reach 75°C throughout.',
  },
  {
    n: 5, cat: CAT.temperature, difficulty: 4, marks: 3, secs: 90,
    type: 'fill_blank', format: 'blanks',
    stem: 'Complete the danger zone.',
    content: { format: 'blanks',
      template: 'Bacteria multiply fastest between {{low}}°C and {{high}}°C.',
      blanks: [{ id: 'low' }, { id: 'high' }] },
    key: { format: 'blanks', partialCredit: true, blanks: [
      { id: 'low', accept: ['5', 'five'], match: 'ci' },
      { id: 'high', accept: ['63', 'sixty three', 'sixty-three'], match: 'ci' }] },
  },
  {
    n: 6, cat: CAT.knives, difficulty: 3, marks: 4, secs: 120,
    type: 'sequence', format: 'order',
    stem: 'Put the mise en place steps in the correct order.',
    content: { format: 'order', items: [
      { id: 's1', text: 'Wash hands' },
      { id: 's2', text: 'Sanitise the board' },
      { id: 's3', text: 'Sharpen the knife' },
      { id: 's4', text: 'Portion the fish' },
      { id: 's5', text: 'Clean down' }] },
    key: { format: 'order', correct: ['s1', 's2', 's3', 's4', 's5'], scoring: 'adjacent' },
  },
  {
    n: 7, cat: CAT.knives, difficulty: 2, marks: 2, secs: 45,
    type: 'mcq_single', format: 'choice_single',
    stem: 'Which knife is correct for filleting a whole fish?',
    content: { format: 'choice_single', choices: [
      { id: 'a', text: 'Chef’s knife' }, { id: 'b', text: 'Flexible filleting knife' },
      { id: 'c', text: 'Cleaver' }, { id: 'd', text: 'Paring knife' }] },
    key: { format: 'choice_single', correct: 'b' },
  },
  {
    n: 8, cat: CAT.allergens, difficulty: 4, marks: 3, secs: 60,
    type: 'mcq_multi', format: 'choice_multi',
    stem: 'Which of these are among the 14 declarable allergens?',
    content: { format: 'choice_multi', choices: [
      { id: 'a', text: 'Sesame' }, { id: 'b', text: 'Celery' },
      { id: 'c', text: 'Black pepper' }, { id: 'd', text: 'Lupin' }] },
    key: { format: 'choice_multi', correct: ['a', 'b', 'd'], partialCredit: true },
  },
  {
    n: 9, cat: CAT.allergens, difficulty: 3, marks: 1, secs: 30,
    type: 'true_false', format: 'boolean',
    stem: 'A guest with a severe allergy can be served if the dish is simply made without the ingredient.',
    content: { format: 'boolean' },
    key: { format: 'boolean', correct: false },
    explanation: 'Cross-contact during prep matters as much as the recipe. Separate equipment is required.',
  },
  {
    n: 10, cat: CAT.hygiene, difficulty: 2, marks: 2, secs: 45,
    type: 'mcq_single', format: 'choice_single',
    stem: 'How long should hand washing take to be effective?',
    content: { format: 'choice_single', choices: [
      { id: 'a', text: '5 seconds' }, { id: 'b', text: '10 seconds' },
      { id: 'c', text: '20 seconds' }, { id: 'd', text: '60 seconds' }] },
    key: { format: 'choice_single', correct: 'c' },
  },
  {
    n: 11, cat: CAT.service, difficulty: 3, marks: 5, secs: 240,
    type: 'essay', format: 'text_long',
    stem: 'A guest returns a dish saying it is cold. Describe how you would handle it, start to finish.',
    content: { format: 'text_long', maxWords: 250 },
    key: { format: 'text_long', rubric: [
      { id: 'c1', label: 'Apologises without blaming the kitchen', max: 2 },
      { id: 'c2', label: 'Removes the dish and offers a remedy', max: 2 },
      { id: 'c3', label: 'Informs the kitchen so the cause is fixed', max: 1 }] },
  },
  {
    n: 12, cat: CAT.bar, difficulty: 2, marks: 2, secs: 45,
    type: 'mcq_single', format: 'choice_single',
    stem: 'What must you do if a guest appears intoxicated and orders another drink?',
    content: { format: 'choice_single', choices: [
      { id: 'a', text: 'Serve it — they are paying' },
      { id: 'b', text: 'Refuse politely and offer water or food' },
      { id: 'c', text: 'Water the drink down without telling them' },
      { id: 'd', text: 'Ask another member of staff to serve it' }] },
    key: { format: 'choice_single', correct: 'b' },
  },
]

async function seed() {
  const { rows: author } = await db.query(
    `select id from public.profiles
      where company_id = $1 and approval_status = 'approved' and deleted_at is null
      order by created_at limit 1`,
    [COMPANY],
  )
  if (!author.length) {
    throw new Error('No approved profile in the company to author demo content. Approve an account first.')
  }
  const authorId = author[0].id

  for (const item of QUESTIONS) {
    await db.query(
      `insert into public.questions
         (id, company_id, type, response_format, stem, content, category_id,
          difficulty, marks, status, created_by, estimated_seconds, explanation, source)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'active',$10,$11,$12,'manual')
       on conflict (id) do nothing`,
      [q(item.n), COMPANY, item.type, item.format, item.stem, JSON.stringify(item.content),
       item.cat, item.difficulty, item.marks, authorId, item.secs, item.explanation ?? null],
    )
    await db.query(
      `insert into public.question_answer_keys (question_id, answer_key)
       values ($1,$2::jsonb) on conflict (question_id) do nothing`,
      [q(item.n), JSON.stringify(item.key)],
    )
  }
  console.log(`  ${QUESTIONS.length} questions (active, across 6 formats)`)

  /*
   * ── A published exam, so the frozen paper, its provenance and its
   *    immutability are all demonstrable.
   *
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE DRAFT EXAM WAS REMOVED ON 11 AUG 2026. IT HAD NOWHERE LEFT TO SHOW.  │
   * │                                                                           │
   * │ 'Monthly Knowledge Check — August' existed "so the builder and health     │
   * │ report are demonstrable", and both were deleted in the consolidation:     │
   * │ there is no /exams list, no /exams/new and no /exams/[id]. A draft is     │
   * │ visible on none of /exams/live, /upcoming or /closed — examState() reads  │
   * │ the window, and a draft has none — and none of /my-exams either.          │
   * │                                                                           │
   * │ So seeding it put a row in the database that no screen in the product     │
   * │ could render, which is worse than nothing in a script whose whole job is  │
   * │ to make the product demonstrable. clean() still deletes it by id, so a    │
   * │ database seeded before today loses it on the next `--clean`.              │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const exams = [
    { id: EXAM_PUBLISHED, title: 'Food Safety — Level 1', kind: 'official', publish: true,
      sections: [
        { title: 'Temperature control', cat: CAT.temperature, count: 2 },
        { title: 'Safe handling', cat: CAT.foodSafety, count: 2 },
      ] },
  ]

  for (const exam of exams) {
    const { rowCount } = await db.query(
      `insert into public.exams
         (id, company_id, title, description, created_by, kind, duration_minutes,
          max_attempts, pass_mark_percent, closes_at)
       values ($1,$2,$3,$4,$5,$6,20,2,60, now() + interval '30 days')
       on conflict (id) do nothing`,
      [exam.id, COMPANY, exam.title,
       'Demo content — created by scripts/seed-demo.mjs', authorId, exam.kind],
    )
    if (rowCount === 0) continue // already seeded; leave it exactly as it is

    for (const [i, section] of exam.sections.entries()) {
      const { rows: sec } = await db.query(
        `insert into public.exam_sections (exam_id, title, sort_order) values ($1,$2,$3) returning id`,
        [exam.id, section.title, i],
      )
      await db.query(
        `insert into public.exam_rules
           (section_id, category_id, question_count, difficulty_min, difficulty_max, sort_order)
         values ($1,$2,$3,1,5,0)`,
        [sec[0].id, section.cat, section.count],
      )
    }
    await db.query(
      `insert into public.exam_assignments (exam_id, target_kind, target_id)
       values ($1,'outlet',$2) on conflict do nothing`,
      [exam.id, OUTLET_AIKO],
    )

    if (exam.publish) {
      // Through the real function, so the paper is genuinely frozen and the
      // demo shows the same thing a chef would produce.
      await db.query('select set_config($1,$2,true)', [
        'request.jwt.claims',
        JSON.stringify({
          sub: authorId,
          app: { approved: true, company_id: COMPANY, outlet_id: OUTLET_AIKO,
                 roles: ['super_admin'], perms: [] },
        }),
      ])
      await db.query('select * from public.publish_exam($1)', [exam.id])
    }
    console.log(`  exam: ${exam.title}${exam.publish ? ' (published)' : ' (draft)'}`)
  }
}

async function clean() {
  await db.query('delete from public.exams where id = any($1::uuid[])', [
    [EXAM_PUBLISHED, EXAM_DRAFT],
  ])
  await db.query(
    `delete from public.email_outbox where payload ->> 'dedupe_key' like any ($1::text[])`,
    [[`exam-assigned:${EXAM_PUBLISHED}%`, `exam-assigned:${EXAM_DRAFT}%`]],
  )
  await db.query('delete from public.questions where id = any($1::uuid[])', [
    QUESTIONS.map((item) => q(item.n)),
  ])
  console.log('  demo content removed')
}

await db.connect()
try {
  await db.query('begin')
  if (process.argv.includes('--clean')) {
    console.log('Removing demo content:')
    await clean()
  } else {
    console.log('Seeding demo content:')
    await seed()
  }
  await db.query('commit')
} catch (e) {
  await db.query('rollback')
  console.error('\nFailed:', e.message)
  process.exitCode = 1
} finally {
  await db.end()
}
