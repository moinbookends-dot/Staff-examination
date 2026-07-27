import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * Two test projects, deliberately separated (see plan §11):
 *
 *  unit — pure functions only. The auto-grading engine lives here and is the
 *         one place we hold to 100% branch coverage: it is pure, fast, and a
 *         bug in it silently produces wrong grades that a human will trust.
 *         No database, no network, runs everywhere.
 *
 *  rls  — policy tests against a real Postgres. Requires DATABASE_URL. In CI
 *         that is a service container seeded by supabase/tests/bootstrap.sql.
 *         Skipped locally unless DATABASE_URL is set, because there is no
 *         local Supabase stack on this machine.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Only so CI is green between scaffold and the first real tests (M1).
    // Remove once tests/unit/grading/ exists — after that, "no tests found"
    // means something was deleted, and that should fail loudly.
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'rls',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          // Policy tests share one database; parallel transactions on the same
          // rows produce flakes that look like policy bugs. Not worth debugging.
          fileParallelism: false,
          testTimeout: 30_000,
          // hookTimeout MUST be set too, and its absence was a real bug rather
          // than a tuning nicety. It defaults to 10s regardless of testTimeout,
          // and these beforeAll blocks build fixtures over ~20 sequential round
          // trips to a database in another region. Run alone that fits; run as
          // `npm test`, with the unit project competing for CPU and network, it
          // tipped over and a DIFFERENT suite failed each time — which reads
          // exactly like nondeterministic flakiness and is not.
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
