'use client'

import dynamic from 'next/dynamic'
import type { ComponentType } from 'react'
import { RESPONSE_FORMATS, type ResponseFormat } from '@/lib/questions/schemas'
import type { FormatEditorProps, FormatRendererProps } from './types'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE UI FORMAT REGISTRY — the counterpart to src/lib/questions/registry.ts ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The headless registry holds everything about a format that is not a React
 * component: labels, CSV round-tripping, empty values, samples. This holds the
 * two components. THIS FILE IMPORTS THAT ONE'S TYPES, NEVER THE REVERSE —
 * a headless registry that imported React would break the plain-Node import
 * scripts and drag editor code into the server bundle.
 *
 * ADDING A FORMAT is three entries: one in the headless registry, one editor,
 * one renderer. tests/unit/ui-registry.test.ts fails if either component here
 * is missing, so "add it in one place" stays true rather than being a comment
 * that used to be true.
 *
 * WHY THE THUNKS ARE EXPORTED SEPARATELY from the components that resolve them:
 * FORMAT_UI is a plain object of `() => import(…)` functions with no React in
 * it, so the conformance test can assert completeness in a Node environment
 * without rendering anything or standing up a DOM.
 */

type EditorLoader = () => Promise<{ default: ComponentType<FormatEditorProps> }>
type RendererLoader = () => Promise<{ default: ComponentType<FormatRendererProps> }>

export interface FormatUiEntry {
  editor: EditorLoader
  renderer: RendererLoader
}

/**
 * Static, literal import paths. A computed `import(\`./editors/${format}\`)`
 * would be one line instead of thirty-six, and would also defeat bundler
 * analysis: every editor would end up in every chunk, and a format with a typo
 * in its name would fail at runtime in front of a chef instead of at build.
 */
export const FORMAT_UI: Record<ResponseFormat, FormatUiEntry> = {
  choice_single: {
    editor: () => import('./editors/choice-single-editor'),
    renderer: () => import('./renderers/choice-single-renderer'),
  },
  choice_multi: {
    editor: () => import('./editors/choice-multi-editor'),
    renderer: () => import('./renderers/choice-multi-renderer'),
  },
  boolean: {
    editor: () => import('./editors/boolean-editor'),
    renderer: () => import('./renderers/boolean-renderer'),
  },
  blanks: {
    editor: () => import('./editors/blanks-editor'),
    renderer: () => import('./renderers/blanks-renderer'),
  },
  pairs: {
    editor: () => import('./editors/pairs-editor'),
    renderer: () => import('./renderers/pairs-renderer'),
  },
  order: {
    editor: () => import('./editors/order-editor'),
    renderer: () => import('./renderers/order-renderer'),
  },
  text_short: {
    editor: () => import('./editors/text-short-editor'),
    renderer: () => import('./renderers/text-short-renderer'),
  },
  text_long: {
    editor: () => import('./editors/text-long-editor'),
    renderer: () => import('./renderers/text-long-renderer'),
  },
  evaluator_only: {
    editor: () => import('./editors/evaluator-only-editor'),
    renderer: () => import('./renderers/evaluator-only-renderer'),
  },
}

function Loading() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  )
}

/**
 * Resolved once, at module load — NOT during render.
 *
 * dynamic() returns a new component identity on every call. Calling it while
 * rendering would hand React a different component type on each keystroke, so
 * it would unmount the editor and mount a fresh one: the chef's cursor jumps
 * out of the input they are typing in. Building the table once means the
 * identity is stable for the life of the page.
 *
 * This costs nothing at load. dynamic() only registers the loader; the chunk is
 * still fetched lazily, the first time a format is actually rendered.
 */
const EDITORS = Object.fromEntries(
  RESPONSE_FORMATS.map((format) => [format, dynamic(FORMAT_UI[format].editor, { loading: Loading })]),
) as Record<ResponseFormat, ComponentType<FormatEditorProps>>

const RENDERERS = Object.fromEntries(
  RESPONSE_FORMATS.map((format) => [format, dynamic(FORMAT_UI[format].renderer, { loading: Loading })]),
) as Record<ResponseFormat, ComponentType<FormatRendererProps>>

export function FormatEditor({
  format,
  ...props
}: FormatEditorProps & { format: ResponseFormat }) {
  const Editor = EDITORS[format]
  return <Editor {...props} />
}

export function FormatRenderer({
  format,
  ...props
}: FormatRendererProps & { format: ResponseFormat }) {
  const Renderer = RENDERERS[format]
  return <Renderer {...props} />
}
