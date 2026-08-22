/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The order in which rows may be offered to bank_import_commit.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A RE-IMPORT CAN MOVE TEXT BETWEEN QUESTIONS, AND THE INDEX SEES THE       ║
 * ║ HALFWAY POINT.                                                            ║
 * ║                                                                           ║
 * ║ 0054 carries                                                              ║
 * ║                                                                           ║
 * ║   unique (brand_id, difficulty, lower(btrim(question))) where locale='en' ║
 * ║                                                                           ║
 * ║ as a PARTIAL UNIQUE INDEX. A partial unique index cannot be declared      ║
 * ║ DEFERRABLE, so Postgres evaluates it at the end of every statement — not  ║
 * ║ at commit. bank_import_commit writes one row at a time inside its         ║
 * ║ transaction, so every intermediate state is checked.                      ║
 * ║                                                                           ║
 * ║ That is fine while a re-import only edits text in place. It is not fine   ║
 * ║ when a revision REASSIGNS existing text to a different externalId: for    ║
 * ║ the moment between rewriting the claimant and rewriting the previous      ║
 * ║ owner, both hold the same string, and the index correctly refuses with    ║
 * ║ 23505.                                                                    ║
 * ║                                                                           ║
 * ║ On 18 Aug 2026 a Hard re-import failed exactly this way at row 412:       ║
 * ║ aiko-hard-0412's new stem was still held by aiko-hard-0413, which the     ║
 * ║ file listed AFTER it. Four batches had already committed.                 ║
 * ║                                                                           ║
 * ║ This is the rename-collision problem — `mv a b` while `b` still exists.   ║
 * ║ The fix is ordering, not a weaker constraint: update the releasing        ║
 * ║ question before the claiming one.                                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ KEYS ARE COMPUTED BY POSTGRES, NOT BY JAVASCRIPT.                        │
 * │                                                                           │
 * │ Callers pass keys that Postgres already normalised with the index's own   │
 * │ expression. This module never calls toLowerCase() or trim().              │
 * │                                                                           │
 * │ It would be one line to normalise here and it would be wrong: btrim(x)    │
 * │ with one argument strips SPACES only, while JavaScript's .trim() also     │
 * │ strips tabs, newlines and NBSP — and lower() is collation-aware where     │
 * │ toLowerCase() is not. A key that disagrees with the index by one          │
 * │ character produces an order this module calls safe and the database then  │
 * │ rejects, which is the failure we are here to prevent.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EACH QUESTION HAS AT MOST ONE BLOCKER, WHICH IS WHY THIS IS SIMPLE.      │
 * │                                                                           │
 * │ A key identifies exactly one current owner, so "who must go before me" is │
 * │ a function, not a set. The dependency graph is therefore a functional     │
 * │ graph: disjoint chains, each possibly ending in a cycle. Walking the      │
 * │ single link is enough — no general topological machinery is needed, and   │
 * │ cycle detection is a revisit check on the walk.                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Work out a safe application order for one import.
 *
 * @param {{externalId: string, key: string}[]} items
 *        The rows in FILE ORDER. `key` is the normalised English text the row
 *        WANTS to end up with, already computed by Postgres.
 * @param {Map<string, string>} ownership
 *        Normalised text → the externalId that holds it in the database RIGHT
 *        NOW. Must include soft-deleted questions: the index is deliberately
 *        not scoped to `deleted_at is null`, so a deleted question still
 *        occupies its slot.
 *
 * @returns {{
 *   ok: boolean,
 *   order: string[],
 *   edges: {dependent: string, blocker: string}[],
 *   reordered: number,
 *   moved: {externalId: string, from: number, to: number}[],
 *   cycles: string[][],
 *   problems: string[],
 * }}
 */
export function planImportOrder(items, ownership) {
  const problems = []
  const cycles = []
  const edges = []

  const byId = new Map()
  for (const item of items) byId.set(item.externalId, item)

  /*
   * The file must not contain the same English twice. parse-aiko-hard.mjs
   * already checks this, but a caller that skipped the parser would otherwise
   * get an "unsafe ordering" further down, which describes the symptom rather
   * than the cause.
   */
  const firstUse = new Map()
  for (const item of items) {
    const first = firstUse.get(item.key)
    if (first !== undefined) {
      problems.push(
        `duplicate English text in the import file: ${first} and ${item.externalId} — ` +
          `0054 will refuse one of them whatever the order`,
      )
    } else {
      firstUse.set(item.key, item.externalId)
    }
  }

  // ── Who must go before whom ───────────────────────────────────────────────
  const blocker = new Map()
  for (const item of items) {
    const owner = ownership.get(item.key)
    if (owner === undefined || owner === item.externalId) continue

    if (!byId.has(owner)) {
      /*
       * The holder is not in this import, so nothing in this run will ever make
       * it let go. Reordering cannot help; the file and the bank genuinely
       * disagree about which question owns that sentence.
       */
      problems.push(
        `${item.externalId} wants text currently held by ${owner}, which is not in this ` +
          `import — it will never release it`,
      )
      continue
    }

    blocker.set(item.externalId, owner)
    edges.push({ dependent: item.externalId, blocker: owner })
  }

  // ── Emit in file order, pulling each blocker forward just in time ─────────
  /*
   * Depth-first along the single blocker link, driven by file order. A row
   * moves only when something it depends on has not been written yet, so a
   * file needing no reordering comes back byte-identical.
   */
  const order = []
  const done = new Set()
  const onPath = new Set()
  const path = []

  const emit = (id) => {
    if (done.has(id)) return

    if (onPath.has(id)) {
      cycles.push(path.slice(path.indexOf(id)).concat(id))
      return
    }

    onPath.add(id)
    path.push(id)

    const before = blocker.get(id)
    if (before !== undefined && !done.has(before)) emit(before)

    path.pop()
    onPath.delete(id)

    if (!done.has(id)) {
      done.add(id)
      order.push(id)
    }
  }

  for (const item of items) emit(item.externalId)

  const uniqueCycles = dedupeCycles(cycles)
  for (const cycle of uniqueCycles) {
    problems.push(
      `dependency cycle, which no single-pass order can satisfy: ${cycle.join(' → ')}`,
    )
  }

  // ── Prove it, rather than trusting it ────────────────────────────────────
  /*
   * Replay the plan against a copy of the live ownership map. This is the
   * check that actually protects the database: if the walk above ever produced
   * an order the index would reject, the import refuses here instead of
   * discovering it partway through batch five.
   */
  if (uniqueCycles.length === 0) {
    const holds = new Map(ownership)
    const heldBy = new Map()
    for (const [key, id] of ownership) heldBy.set(id, key)

    for (const id of order) {
      const item = byId.get(id)
      if (item === undefined) continue

      const owner = holds.get(item.key)
      if (owner !== undefined && owner !== id) {
        problems.push(
          `ordering is unsafe: writing ${id} would collide with ${owner}, which still holds ` +
            `that text`,
        )
        break
      }

      const previous = heldBy.get(id)
      if (previous !== undefined) holds.delete(previous)
      holds.set(item.key, id)
      heldBy.set(id, item.key)
    }
  }

  if (order.length !== items.length) {
    problems.push(`planned ${order.length} rows for an import of ${items.length}`)
  }

  // ── How far anything actually moved ──────────────────────────────────────
  const finalIndex = new Map()
  order.forEach((id, i) => finalIndex.set(id, i))

  const moved = []
  items.forEach((item, from) => {
    const to = finalIndex.get(item.externalId)
    if (to !== undefined && to !== from) moved.push({ externalId: item.externalId, from, to })
  })

  return {
    ok: problems.length === 0,
    order,
    edges,
    reordered: moved.length,
    moved,
    cycles: uniqueCycles,
    problems,
  }
}

/**
 * Reorder the rows a caller is about to send, given a plan.
 *
 * Kept separate so the plan can be reported and refused without ever touching
 * the payload.
 *
 * @template {{externalId?: string}} T
 * @param {T[]} rows
 * @param {string[]} order
 * @param {(row: T) => string} idOf
 * @returns {T[]}
 */
export function applyOrder(rows, order, idOf = (row) => row.externalId) {
  const byId = new Map()
  for (const row of rows) byId.set(idOf(row), row)

  const out = []
  for (const id of order) {
    const row = byId.get(id)
    if (row !== undefined) out.push(row)
  }
  return out
}

/**
 * One cycle reached from four different starting points is one cycle, not four.
 * Rotated to its smallest member so the same loop always prints the same way.
 */
function dedupeCycles(cycles) {
  const seen = new Set()
  const out = []

  for (const cycle of cycles) {
    const ring = cycle.slice(0, -1)
    if (ring.length === 0) continue

    let at = 0
    for (let i = 1; i < ring.length; i += 1) if (ring[i] < ring[at]) at = i

    const rotated = ring.slice(at).concat(ring.slice(0, at))
    const signature = rotated.join(' ')
    if (seen.has(signature)) continue

    seen.add(signature)
    out.push(rotated.concat(rotated[0]))
  }

  return out
}
