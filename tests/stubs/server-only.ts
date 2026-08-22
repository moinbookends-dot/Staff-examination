/**
 * A no-op stand-in for the `server-only` package, used by the unit tests.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY STUB IT RATHER THAN DROP THE IMPORT FROM THE MODULES THAT USE IT.     │
 * │                                                                           │
 * │ `import 'server-only'` throws the moment a module is pulled into a client │
 * │ bundle. On src/lib/pdf/* that guard is load-bearing: the PDF engine reads │
 * │ font files off disk and would otherwise be a build error nobody sees      │
 * │ until it ships, or worse a 2 MB font shipped to a browser.                │
 * │                                                                           │
 * │ Vitest's node environment is neither a server component nor a client one, │
 * │ so the real package refuses it. Removing the import to make tests pass    │
 * │ would delete a production safeguard to satisfy the test runner, which is  │
 * │ exactly backwards.                                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export {}
