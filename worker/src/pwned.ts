/**
 * "Has this password already been in a breach?"
 *
 * Length rules stop nothing. `Password1!` satisfies most of them and appears
 * in breach corpora millions of times; a passphrase of four ordinary words
 * fails half of them and appears nowhere. What actually predicts whether a
 * password will be guessed is whether someone has already guessed it.
 *
 * Have I Been Pwned's range endpoint answers that for free and without a key.
 * The trick is k-anonymity: only the FIRST FIVE characters of the SHA-1 go
 * over the wire. The response is every suffix sharing that prefix — several
 * hundred of them — and the comparison happens here. The password, its full
 * hash, and which account it belongs to never leave this worker, and the
 * service cannot tell which of the hundreds was being asked about.
 */

const PREFIX_LENGTH = 5

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

export interface BreachVerdict {
  /** How many breach records hold this exact password. 0 means none seen. */
  count: number
  /** False when the service could not be reached; `count` is then meaningless. */
  checked: boolean
}

/**
 * Fails open, and says so.
 *
 * If the service is slow or down, a shopper must still be able to set a
 * password — an outage somewhere else is not a reason to close registration.
 * The caller gets `checked: false` so it can tell "this password is fine" from
 * "nobody asked", and never reports the second as the first.
 */
export async function breachCount(password: string): Promise<BreachVerdict> {
  try {
    const hash = await sha1Hex(password)
    const prefix = hash.slice(0, PREFIX_LENGTH)
    const suffix = hash.slice(PREFIX_LENGTH)

    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: {
        // Asks for the response to be padded with decoy entries, so the size
        // of the reply cannot hint at how many real matches there were.
        'Add-Padding': 'true',
        'user-agent': 'nexus-tech-collective',
      },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return { count: 0, checked: false }

    for (const line of (await res.text()).split('\n')) {
      const [candidate, seen] = line.trim().split(':')
      if (candidate === suffix) return { count: Number(seen) || 0, checked: true }
    }
    return { count: 0, checked: true }
  } catch {
    return { count: 0, checked: false }
  }
}

/**
 * The bar for refusing outright.
 *
 * Not "appears at all". Plenty of decent passwords appear once or twice in a
 * corpus of fourteen billion records, and refusing those trains people to add
 * a digit to something worse. Ten or more means it is on a list somebody is
 * already spraying.
 */
const REFUSE_AT = 10

export async function tooCommon(password: string): Promise<string | null> {
  const { count, checked } = await breachCount(password)
  if (!checked || count < REFUSE_AT) return null
  return `That password appears in ${count.toLocaleString()} known breaches. Choose one that does not.`
}
