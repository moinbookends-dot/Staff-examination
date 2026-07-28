import { requirePermission } from '@/lib/auth/guards'
import { getTeamStats, getExamStats, getQuestionStats } from '@/server/actions/reports'
import { toCsv, exportFilename, type Column } from '@/lib/reports/csv'

/**
 * CSV export.
 *
 * Lives under /api rather than under [locale] because src/proxy.ts excludes
 * /api from locale routing — its matcher comment says so in as many words, and
 * a download must not be redirected to /en/… on its way out.
 *
 * AUTHORISATION IS THIS FILE'S OWN JOB. Being outside the proxy's matcher means
 * nothing has checked the session before this runs, so requirePermission() is
 * load-bearing here in a way it is not on a page that the proxy already
 * guarded. Beyond that, each report function scopes itself: a chef exporting
 * the team gets their outlet, HR gets the company, and neither is decided here.
 */

export const dynamic = 'force-dynamic'

type Dataset = 'team' | 'exams' | 'questions'

const DATASETS: Record<Dataset, true> = { team: true, exams: true, questions: true }

const TEAM_COLUMNS: Column<Awaited<ReturnType<typeof getTeamStats>>[number]>[] = [
  { key: 'full_name', header: 'Name', kind: 'text' },
  { key: 'attempts_n', header: 'Exams taken', kind: 'number' },
  { key: 'passed_n', header: 'Passed', kind: 'number' },
  { key: 'pass_rate', header: 'Pass rate %', kind: 'number' },
  { key: 'avg_percent', header: 'Average %', kind: 'number' },
  { key: 'last_attempt_at', header: 'Last taken', kind: 'date' },
]

const EXAM_COLUMNS: Column<Awaited<ReturnType<typeof getExamStats>>[number]>[] = [
  { key: 'title', header: 'Exam', kind: 'text' },
  { key: 'attempts_n', header: 'Attempts', kind: 'number' },
  { key: 'candidates_n', header: 'People', kind: 'number' },
  { key: 'pass_rate', header: 'Pass rate %', kind: 'number' },
  { key: 'avg_percent', header: 'Average %', kind: 'number' },
  { key: 'median_percent', header: 'Median %', kind: 'number' },
  { key: 'avg_minutes', header: 'Average minutes', kind: 'number' },
]

const QUESTION_COLUMNS: Column<Awaited<ReturnType<typeof getQuestionStats>>[number]>[] = [
  { key: 'stem', header: 'Question', kind: 'text' },
  { key: 'question_revision', header: 'Revision', kind: 'number' },
  { key: 'category_name', header: 'Category', kind: 'text' },
  { key: 'attempts_n', header: 'Responses', kind: 'number' },
  { key: 'facility', header: 'Marks earned (0-1)', kind: 'number' },
  { key: 'full_marks_rate', header: 'Full marks rate (0-1)', kind: 'number' },
  // Empty where there were too few responses. An empty cell is the honest
  // rendering of "we will not say", and it is why this column is a number
  // rather than a string carrying an explanation.
  { key: 'discrimination', header: 'Discrimination', kind: 'number' },
  { key: 'author_difficulty', header: 'Rated difficulty', kind: 'number' },
  { key: 'observed_difficulty', header: 'Observed difficulty', kind: 'number' },
  { key: 'misrated', header: 'Check the rating', kind: 'text' },
]

export async function GET(request: Request) {
  // The guards throw typed errors carrying a status, which a page's error
  // boundary turns into a redirect or a 403. A route handler has no boundary,
  // so an uncaught throw here becomes a 500 — which is not merely untidy: it
  // tells the caller the server broke when the truth is that they may not.
  // It also passes any test written as `status !== 200`, which is how this
  // reached the render check before the status was read out loud.
  try {
    await requirePermission('reports.export')
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500
    return new Response(status === 401 ? 'Not signed in' : 'Forbidden', { status })
  }

  const dataset = new URL(request.url).searchParams.get('dataset') ?? 'team'
  if (!(dataset in DATASETS)) {
    return new Response('Unknown dataset', { status: 400 })
  }

  let csv: string
  switch (dataset as Dataset) {
    case 'exams':
      csv = toCsv(await getExamStats(), EXAM_COLUMNS)
      break
    case 'questions':
      csv = toCsv(await getQuestionStats(), QUESTION_COLUMNS)
      break
    default:
      csv = toCsv(await getTeamStats(), TEAM_COLUMNS)
  }

  return new Response(csv, {
    status: 200,
    headers: {
      // charset matters: names and question stems are routinely Devanagari or
      // Gujarati, and without it Excel guesses the local codepage and mangles
      // every one of them.
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFilename(dataset, new Date())}"`,
      // A report of who passed what is not something to leave in a shared cache.
      'cache-control': 'no-store',
    },
  })
}
