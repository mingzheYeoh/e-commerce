/**
 * Outbound email.
 *
 * There is exactly one reason this exists: without a channel to the address
 * someone typed, there is no way to tell a real owner from someone guessing,
 * and registration has to answer "is this email taken?" out loud. Every other
 * fix for that is a workaround for not having this.
 *
 * SMTP is not available from Workers, so this is an HTTP provider behind an
 * interface. Resend is the default because it is a single POST and its free
 * tier covers a store like this one; swapping it is one class.
 */

export interface Mailer {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<boolean>
}

export interface MailEnv {
  /** Set with `wrangler secret put RESEND_API_KEY`. Absent means no transport. */
  RESEND_API_KEY?: string
  /** e.g. "NEXUSOHM <orders@yourdomain.com>" — must be a domain verified with the provider. */
  MAIL_FROM?: string
}

class ResendMailer implements Mailer {
  constructor(
    private readonly key: string,
    private readonly from: string,
  ) {}

  async send(message: { to: string; subject: string; text: string; html: string }): Promise<boolean> {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        // The body carries the provider's reason — an unverified sending
        // domain, usually. Logged without the recipient.
        console.error('mail send failed', res.status, await res.text())
        return false
      }
      return true
    } catch (err) {
      console.error('mail transport error', err)
      return false
    }
  }
}

/**
 * Null when nothing is configured.
 *
 * Null is a decision, not a gap: registration refuses rather than falling back
 * to a flow that quietly announces which addresses already have accounts. The
 * security property fails closed; the feature is what goes dark.
 */
export function mailerFor(env: MailEnv): Mailer | null {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return null
  return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM)
}

/* ------------------------------------------------------------------ bodies */

const shell = (heading: string, body: string, action?: { href: string; label: string }) => `
<!doctype html><html><body style="margin:0;background:#0b0b0d;color:#e8e8ea;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#141417;border:1px solid #26262b;border-radius:12px;padding:32px">
        <tr><td>
          <p style="margin:0 0 24px;font-size:15px;font-weight:800;letter-spacing:-0.02em">NEXUSOHM</p>
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${heading}</h1>
          <div style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#a8a8b0">${body}</div>
          ${
            action
              ? `<a href="${action.href}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px">${action.label}</a>
                 <p style="margin:24px 0 0;font-size:12px;color:#6d6d78;word-break:break-all">Or paste this into your browser:<br>${action.href}</p>`
              : ''
          }
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#6d6d78">This is a demonstration store. Nothing ships and no card is charged.</p>
    </td></tr>
  </table>
</body></html>`

export const verificationEmail = (link: string) => ({
  subject: 'Confirm your NEXUSOHM account',
  text: `Confirm your email to finish setting up your NEXUSOHM account:\n\n${link}\n\nThe link is good for 24 hours. If you did not ask for an account, ignore this — nothing was created you need to undo.`,
  html: shell(
    'Confirm your email',
    'One click and your account is ready. The link is good for 24 hours.<br><br>If you did not ask for an account, ignore this message — nothing happens without it.',
    { href: link, label: 'Confirm email' },
  ),
})

/**
 * Sent when someone tries to register an address that already has an account.
 *
 * This message is the whole trick. Registration answers identically either
 * way, so the fact that the address is taken is told only to the inbox that
 * owns it — and its owner, who may be reading about an attempt they did not
 * make, is handed something useful rather than a dead end.
 */
export const alreadyRegisteredEmail = (signInUrl: string) => ({
  subject: 'Someone tried to create a NEXUSOHM account with your email',
  text: `Someone just tried to sign up with this address, which already has an account.\n\nIf it was you, sign in instead: ${signInUrl}\n\nIf it was not, no action is needed — no second account was created and nothing about yours has changed. Your password still works and has not been seen by anyone.`,
  html: shell(
    'That address already has an account',
    'Someone just tried to sign up with this address. No second account was created.<br><br>If it was you, sign in instead. If it was not, nothing has changed — your password has not been seen and still works.',
    { href: signInUrl, label: 'Sign in' },
  ),
})

/**
 * A way back in for someone who has forgotten their password.
 *
 * Phrased so that a person who did NOT ask for it is told plainly that
 * ignoring the message is enough — the most common recipient of a password
 * reset email is someone whose address a stranger typed by mistake, and they
 * should not be left wondering whether their account is in danger.
 */
export const passwordResetEmail = (link: string) => ({
  subject: 'Reset your NEXUSOHM password',
  text: `Use this link to choose a new password:\n\n${link}\n\nIt is good for one hour and works once. If you did not ask for this, ignore it — your password has not changed and nobody has seen it.`,
  html: shell(
    'Choose a new password',
    'The link below is good for one hour and works once.<br><br>If you did not ask for this, ignore this message. Your password has not changed, and nobody — including whoever requested this — has seen it.',
    { href: link, label: 'Choose a new password' },
  ),
})
