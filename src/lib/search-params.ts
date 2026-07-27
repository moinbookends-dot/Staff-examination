/**
 * URL-state helpers, shared by every list screen.
 *
 * Lives here rather than beside one feature's filters because the question bank
 * and the exam list want identical behaviour, and a second copy is how the two
 * drift into serialising `page=1` differently.
 *
 * The pattern these support: filters live in the URL, not in component state.
 * A chef can bookmark "active knife-skills questions at difficulty 4" and send
 * it to another chef; component state would make that unshareable and lose the
 * filter on every back-navigation.
 */

/**
 * Filters → query string, dropping empties.
 *
 * Empty values are omitted rather than serialised as `status=`, so a bookmark
 * does not accumulate dead parameters every time someone clears a filter.
 */
export function filtersToSearchParams(
  filters: Record<string, string | number | undefined | null>,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue
    // page=1 is the default; carrying it makes every URL look filtered.
    if (key === 'page' && Number(value) <= 1) continue
    params.set(key, String(value))
  }
  return params.toString()
}
