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

/**
 * A shopper as other people see them: first name and last initial
 * ("Ada L."), never the full name or the email.
 */
export function authorOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'A shopper'
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

/** Cleaned, non-empty and at most `max` characters, or null. */
export const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && clean(v) && clean(v).length <= max ? clean(v) : null
