import type { CacheConfig } from "../types"

/**
 * Quora scraping engine selection (mirrors the Amazon/Facebook module shape, minus the paid tier).
 *
 * - `browser` - Playwright-driven Chromium. The robust path and effectively required: Quora is a
 *               JSON SPA that does NOT serve schema.org JSON-LD to logged-out clients, so a real
 *               browser must render the page; the parser then reads each answer from the annotated
 *               DOM. It also scrolls to lazy-load more answers, handles the login-wall overlay, and
 *               replays a logged-in `QUORA_COOKIE`. Requires the optional `playwright` peer.
 * - `http`    - lightweight `fetch`. Quora returns HTTP 403 / an unrendered shell to plain fetch,
 *               so this is best-effort only (it falls back to schema.org `QAPage` JSON-LD on the
 *               rare render that ships it) and degrades with an actionable message.
 * - `auto`    - prefer `browser` when Playwright is available (almost always the right choice for
 *               Quora), otherwise fall back to `http`.
 */
export type QuoraEngine = "auto" | "http" | "browser"

/**
 * An (optional) authenticated Quora session, harvested from a logged-in browser. Logged-out
 * visitors hit a login-wall overlay after the first answer or two; replaying the session cookies
 * lets the scraper read deeper into a question's answers and reach search/topic feeds.
 */
export type QuoraSession = {
  /** Full `key=value; key=value` Cookie header to replay. */
  readonly cookieHeader: string
}

export type QuoraClientConfig = {
  /** Authenticated session; absent means only the first (public) answers are reliably reachable. */
  readonly session?: QuoraSession
  readonly engine: QuoraEngine
  readonly userAgent: string
  /** Minimum delay (ms) enforced between successive Quora requests (anti-bot pacing). */
  readonly minDelayMs: number
  /** Run the browser engine headless. Headful lowers detection but needs a display. */
  readonly headless: boolean
  /** Preferred locale, e.g. `en_US`, forwarded as Accept-Language and to the browser context. */
  readonly locale: string
  readonly cache?: CacheConfig
}

/** A comment left on a Quora answer. */
export type QuoraComment = {
  readonly author: string
  readonly body: string
  readonly upvotes?: number
}

/** A single answer to a Quora question. */
export type QuoraAnswer = {
  /** Stable-ish id (the answer permalink path, or `author|hash` when absent). */
  readonly id: string
  readonly author: string
  /** The answerer's Quora profile URL, when present. */
  readonly authorUrl?: string
  /** Plain-text answer body (HTML stripped from the JSON-LD / embedded JSON). */
  readonly body: string
  /** Upvote count, when Quora exposed it. */
  readonly upvotes?: number
  /** Human-readable / ISO date as Quora rendered it. */
  readonly date?: string
  readonly permalink?: string
  /** Best-effort comments on this answer (usually only the browser engine surfaces these). */
  readonly comments?: readonly QuoraComment[]
}

/** A Quora question's metadata (a "card" in search/topic results, or the head of an answer pull). */
export type QuoraQuestion = {
  /** URL slug, e.g. `What-is-the-best-magnesium-for-sleep`. */
  readonly slug: string
  /** The question text/title. */
  readonly title: string
  readonly url: string
  /** Total number of answers Quora reports, when available. */
  readonly answerCount?: number
  /** Number of people following the question, when available. */
  readonly followerCount?: number
  /** Topics/tags attached to the question, when available. */
  readonly topics?: readonly string[]
}

/** A question together with its scraped answers. */
export type QuoraQuestionWithAnswers = {
  readonly question: QuoraQuestion
  readonly answers: readonly QuoraAnswer[]
}
