/** Display words for the values the worker stores. */
export const METHOD: Record<string, string> = { standard: 'Standard', express: 'Express', overnight: 'Overnight' }

/** Only paid orders reach the console, so this is the one a seller sees. */
export const STATUS: Record<string, string> = { succeeded: 'Paid' }

/** SQLite's UTC `YYYY-MM-DD HH:MM:SS`, as written, minus the seconds. */
export const placed = (at: string) => at.slice(0, 16)
