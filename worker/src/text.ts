/**
 * Text a person typed, as it will be stored: whitespace collapsed and square
 * brackets turned round. Merchant fields reach the AI's context, where a
 * passage header is `[id] title` on its own line — a newline and a bracket
 * inside a spec value could otherwise forge another merchant's product entry
 * next to the real ones. Customer text (reviews, return notes) never reaches
 * the AI, and is cleaned the same way anyway, so no later change to that has
 * to remember it.
 *
 * Shared by both workers, which is why it is not in console.ts.
 */
export const clean = (v: string) => v.replace(/\s+/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')').trim()

/** Cleaned, non-empty and at most `max` characters, or null. */
export const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && clean(v) && clean(v).length <= max ? clean(v) : null
