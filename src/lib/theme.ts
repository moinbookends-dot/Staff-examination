/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The theme, in the two places that must agree: a pre-paint script and React.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THIS IS NOT next-themes ANY MORE.                                     ║
 * ║                                                                           ║
 * ║ next-themes renders its anti-FOUC <script> from inside its provider, and  ║
 * ║ the provider is a Client Component. React 19 refuses to execute a script  ║
 * ║ rendered on the client and says so, loudly, on every client navigation:   ║
 * ║                                                                           ║
 * ║   Encountered a script tag while rendering React component. Scripts       ║
 * ║   inside React components are never executed when rendering on the        ║
 * ║   client.                                                                 ║
 * ║                                                                           ║
 * ║ The warning is correct and the library has no way to turn the script off  ║
 * ║ — it is rendered unconditionally, wrapped in React.memo, before the       ║
 * ║ children (verified in next-themes 0.4.6, the current release).            ║
 * ║                                                                           ║
 * ║ The script only ever needed to exist in the SERVER-rendered HTML: its     ║
 * ║ whole job is to put the class on <html> before the first paint. So it     ║
 * ║ moves to the root layout via next/script's `beforeInteractive`, which is  ║
 * ║ documented as "injected into the initial HTML from the server, downloaded ║
 * ║ before any Next.js module". React never renders a <script> element, so    ║
 * ║ there is nothing left to warn about.                                      ║
 * ║                                                                           ║
 * ║ The app used exactly three things from the library — <ThemeProvider>,     ║
 * ║ useTheme().resolvedTheme/setTheme, and useTheme().theme — so owning it is ║
 * ║ about fifty lines rather than a dependency.                               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type Theme = 'dark' | 'light'

/**
 * Kept as it was under next-themes so nobody is silently logged out of their
 * own preference by an upgrade. next-themes' default storage key is `theme`.
 */
export const THEME_STORAGE_KEY = 'theme'

/** Dark-first, deliberately. There is no system option — see the layout. */
export const DEFAULT_THEME: Theme = 'dark'

/**
 * The pre-paint script, as source text.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EVERY LINE IS INSIDE try/catch, AND THE CATCH IS NOT DECORATIVE.          │
 * │                                                                           │
 * │ localStorage throws — not returns null, THROWS — in Safari private mode   │
 * │ and wherever cookies are blocked. An uncaught throw here happens before   │
 * │ React exists, so it would leave the page unstyled with no error boundary  │
 * │ to catch it. Falling back to the default theme is always safe.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Written as a string rather than a function passed through `toString()`:
 * minifiers are free to rename a function's internals, and this text is
 * injected verbatim into the HTML.
 */
export const THEME_SCRIPT = `
try {
  var t = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
  if (t !== 'light' && t !== 'dark') t = ${JSON.stringify(DEFAULT_THEME)};
  var e = document.documentElement;
  e.classList.toggle('dark', t === 'dark');
  e.style.colorScheme = t;
} catch (_) {
  document.documentElement.classList.add('dark');
  document.documentElement.style.colorScheme = 'dark';
}
`.trim()
