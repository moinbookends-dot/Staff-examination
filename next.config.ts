import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts')

const nextConfig: NextConfig = {
  /*
   * The version the running client can NAME. Baked at build time from the
   * host's commit ref (Render sets RENDER_GIT_COMMIT); 'dev' locally.
   *
   * Exists because of a support loop that cost days: a fix deployed on
   * Wednesday was "still broken" on Friday for one person, and nothing could
   * distinguish "the fix is wrong" from "that device never reloaded". An
   * installed PWA can run week-old code indefinitely. With the stamp shown in
   * Settings, the first diagnostic question becomes checkable in one glance.
   */
  env: {
    NEXT_PUBLIC_BUILD_REF: (process.env.RENDER_GIT_COMMIT ?? 'dev').slice(0, 7),
  },

  // Hosting is deliberately undecided (Vercel Pro vs Cloudflare), so nothing
  // here may rely on host-specific behaviour. Scheduled work runs on Supabase
  // pg_cron rather than a platform scheduler for the same reason.

  images: {
    // Supabase Storage is the only remote image source. Locking the optimiser
    // to that host matters: an unrestricted remote pattern is both an SSRF
    // vector and a way for a third party to burn the bandwidth quota.
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/**',
      },
    ],
    // Question media is capped small at upload (plan §10); these match.
    imageSizes: [64, 128, 256, 384],
    deviceSizes: [640, 828, 1080, 1200],
  },

  // NOTE: Next 16 removed the `eslint` config key — `next build` no longer
  // runs ESLint at all. Linting is a separate CI job (see .github/workflows/ci.yml),
  // which is where it belongs anyway.
}

export default withNextIntl(nextConfig)
