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
 * Filters → query string, dropping empties and defaults.
 *
 * Empty values are omitted rather than serialised as `status=`, so a bookmark
 * does not accumulate dead parameters every time someone clears a filter.
 *
 * `defaults` is the same idea applied to the parsed shape. Once filters come
 * back from a Zod schema WITH defaults, every key is present on every round
 * trip — so without it, choosing one status produces
 * `?status=draft&sort=updated_at&dir=desc&pageSize=25`, and the URL a chef
 * shares is mostly noise restating what was already true. Passing the defaults
 * keeps a shared link about the part that was actually chosen.
 */
export function filtersToSearchParams(
  filters: Record<string, string | number | boolean | undefined | null>,
  defaults: Record<string, string | number | boolean> = {},
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue
    // page=1 is the default; carrying it makes every URL look filtered.
    if (key === 'page' && Number(value) <= 1) continue
    // Compared as strings: the value may have arrived from a query string and
    // come back as a number from Zod's coercion, and 25 !== '25'.
    if (key in defaults && String(defaults[key]) === String(value)) continue
    // `false` is how a boolean filter says "not asked for", and it is the
    // default for every boolean here. Serialising it would also be wrong on
    // the way back: `?deleted=false` is a string, and every non-empty string
    // is truthy to anything that forgets to parse it.
    if (value === false) continue
    params.set(key, value === true ? '1' : String(value))
  }
  return params.toString()
}
