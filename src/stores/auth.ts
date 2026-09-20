import { defineStore } from 'pinia'
import {
  currentAccount,
  registerAccount,
  signIn,
  signOut,
  confirmEmail,
  requestPasswordReset,
  resetPassword,
  type Account,
} from '@/lib/api'

/**
 * Who is signed in.
 *
 * The session itself is not here and cannot be: it is an HttpOnly cookie, so
 * this store holds only what the server said about it. That is the right way
 * round — a token this code could read is a token an injected script could
 * read — but it means the answer arrives asynchronously, and the header has to
 * render before it does.
 *
 * Hence the hint below: the shopper's display name is cached locally so the
 * header can draw itself immediately, and corrected the moment `/api/auth/me`
 * replies. The hint is a display cache with no authority whatsoever — every
 * account-only response comes from the server, which checks the cookie.
 */

const HINT_KEY = 'nexus:account-hint'

const hint = {
  read(): string {
    try {
      return localStorage.getItem(HINT_KEY) ?? ''
    } catch {
      return ''
    }
  },
  write(name: string) {
    try {
      if (name) localStorage.setItem(HINT_KEY, name)
      else localStorage.removeItem(HINT_KEY)
    } catch {
      /* the header falls back to "Sign in" for a moment; nothing breaks */
    }
  },
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as Account | null,
    /** What the last cached sign-in looked like. Never trusted for access. */
    hintName: hint.read(),
    /** 'unknown' until the server has answered once. */
    status: 'unknown' as 'unknown' | 'in' | 'out',
    busy: false,
    error: '',
    /** Set after a registration: what to tell them to go and do. */
    notice: '',
  }),

  getters: {
    signedIn: (state) => state.status === 'in',
    /** The name to show before the server has answered, if any. */
    displayName(state): string {
      return state.user?.name || (state.status === 'unknown' ? state.hintName : '')
    },
    firstName(): string {
      return this.displayName.split(' ')[0] ?? ''
    },
  },

  actions: {
    /** Asked once per page load, by App.vue. */
    async hydrate() {
      const user = await currentAccount()
      this.apply(user)
    },

    apply(user: Account | null) {
      this.user = user
      this.status = user ? 'in' : 'out'
      this.hintName = user?.name ?? ''
      hint.write(this.hintName)
    },

    /**
     * Registering does not sign anyone in.
     *
     * The account is not usable until the link in the email is clicked, which
     * is what makes the address verified rather than merely typed. So this
     * leaves a notice rather than a session.
     */
    async register(name: string, email: string, password: string): Promise<boolean> {
      this.busy = true
      this.error = ''
      this.notice = ''
      const result = await registerAccount(name, email, password)
      this.busy = false

      if (!result.ok) {
        this.error = result.error
        return false
      }
      this.notice = result.message
      return true
    },

    /**
     * Asks for a reset link. Leaves a notice, never a session — the same
     * notice whether or not the address has an account.
     */
    async forgot(email: string): Promise<boolean> {
      this.busy = true
      this.error = ''
      this.notice = ''
      const result = await requestPasswordReset(email)
      this.busy = false

      if (!result.ok) {
        this.error = result.error
        return false
      }
      this.notice = result.message
      return true
    },

    /** Sets a new password from a reset link, which does sign them in. */
    async reset(token: string, password: string): Promise<boolean> {
      this.busy = true
      this.error = ''
      const result = await resetPassword(token, password)
      this.busy = false

      if (!result.ok) {
        this.error = result.error
        return false
      }
      this.apply(result.user)
      return true
    },

    /** Redeems a verification link, which does sign them in. */
    async confirm(token: string): Promise<boolean> {
      this.busy = true
      this.error = ''
      const result = await confirmEmail(token)
      this.busy = false

      if (!result.ok) {
        this.error = result.error
        return false
      }
      this.apply(result.user)
      return true
    },

    async login(email: string, password: string): Promise<boolean> {
      this.busy = true
      this.error = ''
      this.notice = ''
      const result = await signIn(email, password)
      this.busy = false

      if (!result.ok) {
        this.error = result.error
        return false
      }
      this.apply(result.user)
      return true
    },

    async logout() {
      // Cleared locally first so the header reacts immediately; the server call
      // is what actually ends the session, and it is not worth blocking on.
      this.apply(null)
      await signOut()
    },
  },
})
