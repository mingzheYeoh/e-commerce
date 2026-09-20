/**
 * A rate limit that actually counts.
 *
 * Cloudflare's own rate limiting binding sits in front of this and is worth
 * keeping — it is free and it absorbs the bulk of a flood before any of this
 * runs. But it is explicitly best-effort, and measuring it showed how
 * best-effort: twenty-five parallel sign-up attempts against a 5-per-minute
 * limit produced **one** refusal. The requests land on different isolates and
 * each keeps its own tally.
 *
 * One refusal in twenty-five is fine as a pre-filter and useless as the thing
 * standing between a password list and an account. A Durable Object is
 * single-threaded and addressed by name, so every request for one key reaches
 * the same instance in the same order — which is the entire reason to reach
 * for one.
 *
 * ponytail: fixed window, not a sliding log. A window lets a burst straddle
 * the boundary and land at twice the rate for one instant; a log costs a
 * stored entry per attempt to close a gap that matters to a benchmark and not
 * to an attacker. If that ever stops being true, the upgrade is a two-bucket
 * sliding counter in the same object.
 */

interface Window {
  count: number
  /** Epoch ms at which the tally resets. */
  resetAt: number
}

export class IpThrottle {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { limit, windowSeconds } = (await request.json()) as {
      limit: number
      windowSeconds: number
    }
    const now = Date.now()
    const window = await this.state.storage.get<Window>('window')

    if (!window || window.resetAt <= now) {
      const resetAt = now + windowSeconds * 1000
      await this.state.storage.put('window', { count: 1, resetAt })
      /*
       * An alarm so the object empties itself once the window has passed.
       * Without it every address that ever tried to sign in leaves a Durable
       * Object holding one row forever, and the bill for a failed attack
       * arrives a month later.
       */
      await this.state.storage.setAlarm(resetAt + 1000)
      return Response.json({ success: true, retryAfter: 0 })
    }

    if (window.count >= limit) {
      return Response.json({
        success: false,
        retryAfter: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      })
    }

    await this.state.storage.put('window', { ...window, count: window.count + 1 })
    return Response.json({ success: true, retryAfter: 0 })
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }
}

export interface ThrottleBinding {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

export interface ThrottleVerdict {
  ok: boolean
  retryAfter: number
}

/**
 * Asks the object responsible for this key whether one more is allowed.
 *
 * Fails open, loudly. A throttle that takes the service down with it when it
 * is unavailable turns a dependency blip into an outage — but a silent
 * fail-open is how a defence stops working without anyone noticing, so it is
 * logged every time.
 */
export async function throttle(
  binding: ThrottleBinding | undefined,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<ThrottleVerdict> {
  if (!binding) return { ok: true, retryAfter: 0 }
  try {
    const stub = binding.get(binding.idFromName(key))
    const res = await stub.fetch(
      new Request('https://throttle/', {
        method: 'POST',
        body: JSON.stringify({ limit, windowSeconds }),
      }),
    )
    const verdict = (await res.json()) as { success: boolean; retryAfter: number }
    return { ok: verdict.success, retryAfter: verdict.retryAfter }
  } catch (err) {
    console.error('throttle unavailable', key, err)
    return { ok: true, retryAfter: 0 }
  }
}
