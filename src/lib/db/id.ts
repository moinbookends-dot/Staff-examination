import { z } from 'zod'

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  VALIDATOR FOR A POSTGRES uuid COLUMN. USE THIS, NOT z.string().uuid().   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Zod 4 tightened `.uuid()` to enforce RFC 4122: the version nibble must be
 * 1–8 and the variant nibble 8/9/a/b. Postgres enforces neither — its `uuid`
 * type accepts any 128-bit value — so the two disagree about ids this codebase
 * actually uses.
 *
 * Every fixed id in supabase/seed.sql looks like
 *
 *     00000000-0000-0000-0000-00000000c001
 *
 * which Postgres stores happily and Zod 4 rejects, because both nibbles are 0.
 *
 * WHAT THAT COST: getAppClaims() parsed the JWT's `app` claim with a schema
 * built from z.string().uuid(). For any user in the seeded company the parse
 * failed on company_id, the helper fell through to DENY_ALL, and every
 * authenticated page redirected to /pending — with a valid, correctly-signed
 * token in the cookie. It survived two milestones because the RLS suite talks
 * to Postgres directly and the HTTP walkthrough never renders a page; neither
 * runs this schema. The same latent break sat in approveRegistration, where
 * every seeded outlet and department id would have been rejected.
 *
 * z.guid() checks the SHAPE — 8-4-4-4-12 hex — and nothing else, which is
 * exactly the right contract for a value that came out of a uuid column.
 *
 * Use strict z.uuid() only where a value must genuinely be a v4 UUID minted by
 * this application, never for something read back from the database.
 */
/** `message` surfaces as the field error — e.g. dbId('Select an outlet.'). */
export const dbId = (message?: string) => (message ? z.guid(message) : z.guid())
