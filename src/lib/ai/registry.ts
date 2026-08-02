import {
  ProviderUnavailableError,
  hasCapability,
  type AiCapability,
  type AiProvider,
} from './provider'
import { MOCK_PROVIDER_ID, MockAiProvider } from './mock-provider'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Which provider runs, decided by configuration and by nothing else.
 *
 * No caller anywhere in src/ names a provider. Server actions call
 * resolveProviderFor(capability), get an AiProvider back, and have no way to
 * find out which one they were given short of reading `.id` — which is
 * provenance to record, not a branch to take.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ONE ADAPTER FILE, ONE ENTRY BELOW, AND NOTHING ELSE. THIS IS ENFORCEABLE. │
 * │                                                                           │
 * │ Adding a vendor means writing src/lib/ai/<vendor>-provider.ts exporting a │
 * │ class that implements AiProvider, and adding one line to PROVIDERS naming │
 * │ its id, its credential env var and its constructor. That is the entire    │
 * │ change. No call site moves, no branch is added here, and no type widens,  │
 * │ because:                                                                  │
 * │                                                                           │
 * │   · the credential env var is DATA in the entry, not a condition in this  │
 * │     file — so the "is it configured" check never grows a case;            │
 * │   · PROVIDERS is keyed by `string`, not by a union of known ids, so a new │
 * │     key is not a type change anywhere;                                    │
 * │   · the fallback and the capability check read the entry, so they cover a │
 * │     provider they have never heard of.                                    │
 * │                                                                           │
 * │ KNOWN GAP, stated rather than hidden: nothing mechanically forbids a      │
 * │ server action from importing an adapter directly and skipping all of      │
 * │ this. The protection is that there is nothing to gain by doing it — the   │
 * │ adapter's constructor is where the key is read, and resolveProvider is    │
 * │ the only thing that knows whether the key exists. A lint rule banning     │
 * │ deep imports of ./ai/*-provider outside this file would close it, and     │
 * │ belongs with the first real adapter rather than being invented here.      │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface ProviderEntry {
  /**
   * The env var holding this provider's credential, or null for a provider
   * that needs none. Named, not read, so this record stays a description of
   * what exists rather than a snapshot of what was set at import time.
   */
  readonly credentialEnvVar: string | null
  /**
   * Built per call, not held as a singleton: a provider instance closes over
   * the credential it read at construction, and a rotated key must not have to
   * wait for a process restart to take effect.
   */
  readonly create: () => AiProvider
}

/**
 * Every provider this build knows about.
 *
 * `Record<string, ProviderEntry>` rather than a union of ids on purpose — see
 * the box above. A mutable object rather than a frozen one so the unit suite
 * can register a second provider without a vendor name entering src/; that is
 * the only writer, and it is documented in tests/unit/ai-provider.test.ts.
 */
export const PROVIDERS: Record<string, ProviderEntry> = {
  [MOCK_PROVIDER_ID]: {
    credentialEnvVar: null,
    create: () => new MockAiProvider(),
  },
}

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ READ PER CALL, NOT PARSED AT MODULE LOAD LIKE env.ts.                     │
 * │                                                                           │
 * │ env.ts validates at import and throws at boot, which is right for a       │
 * │ Supabase URL: without it nothing works at all, and finding out during the │
 * │ first request is strictly worse than finding out at startup.              │
 * │                                                                           │
 * │ AI configuration is not like that. The product is fully usable with no    │
 * │ provider — that is what the mock is for — so a missing key must not stop  │
 * │ the app from booting. And a module-load snapshot is the shape that breaks │
 * │ when the key is supplied by the platform's runtime environment rather     │
 * │ than at build: the bundle would have already decided the answer.          │
 * │                                                                           │
 * │ The cost is one `process.env` lookup per resolve, which is a property     │
 * │ read on an object.                                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE DYNAMIC LOOKUP IS SAFE HERE, AND ONLY BECAUSE NOTHING IS PUBLIC.      │
 * │                                                                           │
 * │ env.ts's standing rule is that `process.env.NEXT_PUBLIC_*` must be a full │
 * │ literal expression, because Next.js substitutes those strings at build    │
 * │ time and `process.env[key]` yields undefined in the browser.              │
 * │                                                                           │
 * │ Nothing read in this file is NEXT_PUBLIC_. These are server secrets and   │
 * │ server switches, read in a Node process where process.env is a real       │
 * │ object — so the indexed read works, and it is what buys the one-entry     │
 * │ extension above. The window guard below is what keeps that true: a client │
 * │ component that reached this code would otherwise get a silent `undefined` │
 * │ and quietly report "no AI configured" to every visitor.                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function readServerEnv(name: string): string | undefined {
  if (typeof window !== 'undefined') {
    throw new Error(
      `AI provider configuration ('${name}') was read in the browser. This is a bug — resolve the provider in a server component or action and pass the result down.`,
    )
  }
  const value = process.env[name]
  return value === undefined ? undefined : value.trim()
}

/** The id in AI_PROVIDER, defaulting to the mock. Empty counts as unset. */
export function selectedProviderId(): string {
  const configured = readServerEnv('AI_PROVIDER')
  return configured ? configured : MOCK_PROVIDER_ID
}

/**
 * An entry needs no credential, or has a non-empty one.
 *
 * `.trim()` in readServerEnv is doing real work here: a var set to a blank
 * string in a deployment console is how a key gets "removed", and treating
 * that as present would send a request out with an empty Authorization header
 * and fail as a 401 three layers away from the cause.
 */
function credentialPresent(entry: ProviderEntry): boolean {
  if (entry.credentialEnvVar === null) return true
  return Boolean(readServerEnv(entry.credentialEnvVar))
}

/**
 * The provider to use.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A MISSING CREDENTIAL FALLS BACK. AN UNKNOWN ID THROWS. NOT THE SAME CASE. │
 * │                                                                           │
 * │ Falling back silently is only defensible because of what it falls back    │
 * │ to: the mock's output announces itself in every field and can be found    │
 * │ and purged by one marker. Nobody can mistake a mock run for a real one,   │
 * │ so "no key yet" degrades to "obviously fake output" rather than to a      │
 * │ broken page.                                                              │
 * │                                                                           │
 * │ An unregistered id is the opposite. `AI_PROVIDER=anthopic` is a typo an   │
 * │ operator believes they have configured, and falling back would run the    │
 * │ mock over a real cookbook, at scale, with somebody watching the batch     │
 * │ succeed. That is the one outcome this file exists to prevent, so it       │
 * │ throws and names both the variable and the file that fixes it.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function resolveProvider(): AiProvider {
  const id = selectedProviderId()
  const entry = PROVIDERS[id]

  if (!entry) {
    throw new ProviderUnavailableError('unknown-provider', id)
  }

  if (!credentialPresent(entry)) {
    return PROVIDERS[MOCK_PROVIDER_ID].create()
  }

  return entry.create()
}

/**
 * The provider to use for one job, refusing early if it cannot do it.
 *
 * The alternative is letting the method throw, which happens far later: after
 * a batch row exists, after the pages have been read, and with the failure
 * attributed to the page it happened to be on rather than to the choice of
 * provider. Checking the declared capability first turns that into a refusal
 * before any work starts.
 */
export function resolveProviderFor(capability: AiCapability): AiProvider {
  const provider = resolveProvider()
  if (!hasCapability(provider, capability)) {
    throw new ProviderUnavailableError('capability-missing', provider.id, capability)
  }
  return provider
}

/**
 * Is a real provider configured?
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE MOCK IS NOT A CONFIGURED PROVIDER, EVEN WHEN IT WAS CHOSEN.           │
 * │                                                                           │
 * │ `AI_PROVIDER=mock` is still false here. The question this answers is the  │
 * │ one the UI is asking — "will anything real happen if I press Generate?" — │
 * │ and the answer is no in both the unset case and the deliberate case. A    │
 * │ banner that disappears because somebody explicitly selected the mock is a │
 * │ banner that lies at the exact moment it matters.                          │
 * │                                                                           │
 * │ It also never throws, unlike resolveProvider. An unknown id makes this    │
 * │ false rather than an exception, because this is called to decide whether  │
 * │ to render a warning strip and a typo in an env var must not take the page │
 * │ down with it. The loud failure still happens — at the moment somebody     │
 * │ actually asks for work — which is where it can be acted on.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Server-only, like everything else in this file. A server component reads it
 * and passes the boolean to the client; see readServerEnv.
 */
export function isAiConfigured(): boolean {
  const id = selectedProviderId()
  if (id === MOCK_PROVIDER_ID) return false

  const entry = PROVIDERS[id]
  if (!entry) return false

  return credentialPresent(entry)
}
