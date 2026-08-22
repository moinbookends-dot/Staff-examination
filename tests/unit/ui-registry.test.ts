import { describe, it, expect } from 'vitest'
import { FORMAT_UI } from '@/components/questions/registry'
import { FORMAT_REGISTRY } from '@/lib/questions/registry'
import { RESPONSE_FORMATS } from '@/lib/questions/schemas'

/**
 * UI registry conformance — the assertion that makes "add a format in one
 * place" true rather than aspirational.
 *
 * src/lib/questions/registry.ts promises that adding a format is three entries:
 * a headless definition, an editor and a renderer. Nothing enforced the last
 * two until this file. A missing editor is not a type error — the record is
 * keyed by ResponseFormat, so TypeScript catches an absent key, but not an
 * import path pointing at a file that does not export a component, and not a
 * renderer accidentally wired to the editor.
 *
 * These assertions run in a Node environment and never render. That is why
 * FORMAT_UI exports raw `() => import(…)` thunks separately from the
 * dynamic()-wrapped components — a conformance test should not need a DOM.
 */

describe('UI registry completeness', () => {
  it('has an entry for every response format', () => {
    expect(Object.keys(FORMAT_UI).sort()).toEqual([...RESPONSE_FORMATS].sort())
  })

  it('has no entries for formats that do not exist', () => {
    for (const key of Object.keys(FORMAT_UI)) {
      expect(RESPONSE_FORMATS).toContain(key)
    }
  })

  it('covers exactly the formats the headless registry defines', () => {
    // The two registries are separate modules by design (one must stay free of
    // React). Nothing but this keeps them in step.
    expect(Object.keys(FORMAT_UI).sort()).toEqual(Object.keys(FORMAT_REGISTRY).sort())
  })
})

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE DYNAMIC-IMPORT TESTS BELOW GET A LONGER TIMEOUT, AND IT IS A REAL     │
 * │ FIX RATHER THAN A PAPERED-OVER FLAKE.                                     │
 * │                                                                           │
 * │ `loads an editor component` failed roughly one run in twelve on vitest's  │
 * │ 5000ms default. It is the FIRST `import()` in the file, so it pays the    │
 * │ cold transform cost for the entire editor module graph — every subsequent │
 * │ format hits a warm cache and finishes in single-digit milliseconds. The   │
 * │ variance is Vite's compile step on a cold filesystem cache, not anything  │
 * │ the registry does.                                                        │
 * │                                                                           │
 * │ A timeout that a passing run can exceed is not measuring what it claims   │
 * │ to measure, so it is raised to something the cold path comfortably fits.  │
 * │ These assertions are about whether a module resolves and exports a        │
 * │ component; they were never about how fast it does so.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const LOAD_TIMEOUT_MS = 30_000

describe.each(RESPONSE_FORMATS)('format UI: %s', (format) => {
  const entry = FORMAT_UI[format]

  it('declares both loaders', () => {
    expect(typeof entry.editor).toBe('function')
    expect(typeof entry.renderer).toBe('function')
  })

  it('loads an editor component', async () => {
    const editor = await entry.editor()
    expect(editor.default, `${format} editor has no default export`).toBeTypeOf('function')
  }, LOAD_TIMEOUT_MS)

  it('loads a renderer component', async () => {
    const renderer = await entry.renderer()
    expect(renderer.default, `${format} renderer has no default export`).toBeTypeOf('function')
  }, LOAD_TIMEOUT_MS)

  it('does not wire the renderer to the editor', async () => {
    // A copy-paste slip in the registry table. Both loaders resolve, both export
    // a component, and the preview silently shows the authoring UI.
    const [editor, renderer] = await Promise.all([entry.editor(), entry.renderer()])
    expect(editor.default).not.toBe(renderer.default)
  }, LOAD_TIMEOUT_MS)

  it('names its components after its own format', async () => {
    // Catches the other half of that slip: choice_multi's row pointing at
    // choice_single's editor. Both are valid components, so nothing else here
    // would notice.
    const [editor, renderer] = await Promise.all([entry.editor(), entry.renderer()])
    const expected = format.replace(/_/g, '').toLowerCase()
    expect(editor.default.name.toLowerCase()).toBe(`${expected}editor`)
    expect(renderer.default.name.toLowerCase()).toBe(`${expected}renderer`)
  }, LOAD_TIMEOUT_MS)
})
