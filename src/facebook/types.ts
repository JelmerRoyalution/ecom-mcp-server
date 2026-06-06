import type { CacheConfig } from "../types"

/**
 * Facebook scraping engine selection.
 *
 * - `http`    - lightweight `fetch` against the mobile site (mbasic/m.facebook.com).
 *               Fast and dependency-free, but Facebook increasingly server-renders
 *               via JS, so this is best-effort (works most reliably for public Pages).
 * - `browser` - Playwright-driven Chromium with the user's logged-in session. The only
 *               reliable path for PRIVATE groups and full comment threads in 2025+.
 *               Requires the optional `playwright` peer dependency + a browser binary.
 * - `auto`    - prefer `browser` when Playwright is available and a session is set,
 *               otherwise fall back to `http`.
 */
export type FacebookEngine = "auto" | "http" | "browser"

/**
 * An authenticated Facebook session, harvested from a logged-in browser.
 *
 * `c_user` (numeric account id) and `xs` (session secret) are the two cookies
 * Facebook requires to serve authenticated content; `datr` (device id) reduces
 * the rate of security checkpoints. Private groups are only readable with a
 * session belonging to a member of that group.
 */
export type FacebookSession = {
  /** Full `key=value; key=value` Cookie header to replay. */
  readonly cookieHeader: string
  /** Numeric Facebook user id (the `c_user` cookie). */
  readonly cUser: string
  /** Session secret (the `xs` cookie). */
  readonly xs: string
  /** Optional device identifier (the `datr` cookie) - lowers checkpoint risk. */
  readonly datr?: string
}

export type FacebookClientConfig = {
  /** Authenticated session; absent means only anonymous public reads are attempted. */
  readonly session?: FacebookSession
  readonly engine: FacebookEngine
  readonly userAgent: string
  /** Minimum delay (ms) enforced between successive Facebook requests (anti-bot pacing). */
  readonly minDelayMs: number
  /** Run the browser engine headless. Headful lowers detection but needs a display. */
  readonly headless: boolean
  /** Preferred locale, e.g. `en_US`, forwarded to the mobile site and browser context. */
  readonly locale: string
  readonly cache?: CacheConfig
}

/** A comment (or nested reply) scraped from a Facebook post. */
export type FacebookComment = {
  readonly id: string
  readonly author: string
  readonly authorProfileUrl?: string
  readonly text: string
  readonly likeCount?: number
  /** Human-readable time string as shown by Facebook (exact timestamps are unreliable). */
  readonly timestamp?: string
  readonly permalink?: string
  /** Reply nesting depth (0 = top-level comment). */
  readonly depth: number
}

/** A post scraped from a Facebook group or page feed. */
export type FacebookPost = {
  readonly id: string
  readonly author: string
  readonly authorProfileUrl?: string
  readonly text: string
  readonly permalink?: string
  readonly groupId?: string
  readonly groupName?: string
  readonly likeCount?: number
  readonly commentCount?: number
  readonly shareCount?: number
  readonly timestamp?: string
  readonly images?: readonly string[]
}

export type FacebookGroupPrivacy = "public" | "private" | "unknown"

/** Metadata about a Facebook group. */
export type FacebookGroup = {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly privacy: FacebookGroupPrivacy
  readonly memberCount?: number
  readonly description?: string
}

/** A post together with its scraped comment thread. */
export type FacebookPostWithComments = {
  readonly post: FacebookPost
  readonly comments: readonly FacebookComment[]
}
